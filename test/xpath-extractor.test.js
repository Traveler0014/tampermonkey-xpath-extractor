#!/usr/bin/env node
/*
 * XPath DOM 属性提取器 —— 纯 Node 自动化测试
 *
 * 真实读取并执行 xpath-extractor.user.js，用最小 DOM / XPath 桩验证：
 *   1. 元数据、最小权限与安全隐私审计
 *   2. 提取引擎（属性、相对 URL 补全、特殊节点、标量、异常）
 *   3. 清洗与格式化（换行 / 逗号 / TSV / CSV / JSON、多属性、选项）
 *   4. 零侵入作用域（默认零 DOM 注入、零轮询、按需挂载/卸载、iframe 不激活）
 *
 * 零外部依赖：node test/xpath-extractor.test.js，退出码 0 = 全部通过，1 = 有失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const srcPath = path.join(__dirname, '..', 'xpath-extractor.user.js');
const src = fs.readFileSync(srcPath, 'utf8');
const selfPath = __filename;
const selfSrc = fs.readFileSync(selfPath, 'utf8');
const readmePath = path.join(__dirname, '..', 'README.md');
const readmeSrc = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8') : '';

/* ---------------- XPathResult 常量（与浏览器规范一致） ---------------- */

const XPathResult = {
    ANY_TYPE: 0,
    NUMBER_TYPE: 1,
    STRING_TYPE: 2,
    BOOLEAN_TYPE: 3,
    UNORDERED_NODE_ITERATOR_TYPE: 4,
    ORDERED_NODE_ITERATOR_TYPE: 5,
    UNORDERED_NODE_SNAPSHOT_TYPE: 6,
    ORDERED_NODE_SNAPSHOT_TYPE: 7,
    ANY_UNORDERED_NODE_TYPE: 8,
    FIRST_ORDERED_NODE_TYPE: 9,
};
global.XPathResult = XPathResult;
global.__XPATH_EXTRACTOR_TEST__ = true;

/* ---------------- 断言与统计 ---------------- */

let pass = 0;
let fail = 0;

function check(name, fn) {
    try {
        fn();
        console.log('✓', name);
        pass++;
    } catch (e) {
        console.log('✗', name);
        console.log('   ', e && e.message ? e.message : e);
        fail++;
    }
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg || '断言失败');
}

function eq(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error((msg ? msg + '：' : '') +
            '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
    }
}

/* ================================================================
 * 一、安全与隐私审计（纯结构性）
 *
 * 不使用任何关键词黑名单，而是用结构约束证明仓库里不可能携带私有信息：
 *   1. 所有 URL 主机必须落在公开主机白名单内；
 *   2. 全文不得出现任何 IPv4 字面量（私有网段与内部地址因此无从出现）；
 *   3. 全文不得出现任何邮箱地址；
 *   4. 全文不得出现网络请求 API 或油猴网络权限声明。
 * 同一套规则同时作用于用户脚本、测试脚本与仓库文档。
 * ================================================================ */

// 用户脚本只允许指向自身公开仓库
const SCRIPT_HOSTS = new Set(['github.com', 'raw.githubusercontent.com']);
// 测试脚本在此基础上允许 RFC 2606 占位域名
const TEST_HOSTS = new Set(['github.com', 'raw.githubusercontent.com', 'example.com', 'example.org']);

const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// 命名同样按片段拼接，保证审计规则自身不会在仓库里留下可被滥用的现成调用样例
const NETWORK_APIS = [
    new RegExp('GM' + '\\.xmlHttpRequest'),   // 油猴跨域请求
    new RegExp('XML' + 'HttpRequest'),          // 原生跨域请求
    new RegExp('fe' + 'tch\\s*\\('),            // Fetch
    new RegExp('send' + 'Beacon'),              // 埋点上报
    new RegExp('Web' + 'Socket'),               // 长连接
    new RegExp('^//\\s*@con' + 'nect', 'm'),     // 油猴跨域声明
    new RegExp('^//\\s*@re' + 'quire', 'm'),     // 外部脚本依赖
];

function urlHosts(text) {
    const hosts = new Set();
    const re = /https?:\/\/([^\s'"()<>`]+)/gi;
    let m;
    while ((m = re.exec(text))) {
        hosts.add(m[1].toLowerCase().replace(/^\/*/, '').split(/[/?#]/)[0]);
    }
    return hosts;
}

// 返回问题清单（空数组 = 通过）；只报告结构性问题，不做关键词匹配
function auditText(label, text, allowedHosts, { checkApis = true } = {}) {
    const problems = [];
    (text.match(IPV4_RE) || []).forEach((ip) => {
        problems.push(label + '：出现 IPv4 字面量 ' + ip);
    });
    (text.match(EMAIL_RE) || []).forEach((mail) => {
        problems.push(label + '：出现邮箱地址 ' + mail);
    });
    urlHosts(text).forEach((host) => {
        if (!allowedHosts.has(host)) problems.push(label + '：非白名单主机 ' + host);
    });
    if (checkApis) {
        NETWORK_APIS.forEach((re, i) => {
            if (re.test(text)) problems.push(label + '：出现网络能力 #' + i);
        });
    }
    return problems;
}

/* ---------------- 节点 / 文档桩 ---------------- */

const BASE = 'https://example.com/dir/page.html';

function makeElement(tag, attrs, props) {
    const el = {
        nodeType: 1,
        tagName: tag.toUpperCase(),
        baseURI: BASE,
        _attrs: attrs || {},
        hasAttribute(n) {
            return Object.prototype.hasOwnProperty.call(this._attrs, n);
        },
        getAttribute(n) {
            return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null;
        },
        style: {},
        scrollIntoView() {},
        textContent: '',
        innerText: '',
        innerHTML: '',
        outerHTML: '',
        children: [],
        parentElement: null,
    };
    return Object.assign(el, props || {});
}

// 可挂载的 DOM 节点桩：支持 createElement / append / attachShadow / classList，
// 用于验证「按需挂载 → 关闭卸载」的零侵入行为。
function makeDomNode(tag) {
    const node = {
        nodeType: 1,
        tagName: String(tag || 'div').toUpperCase(),
        id: '',
        className: '',
        textContent: '',
        title: '',
        value: '',
        checked: false,
        style: {},
        children: [],
        parentNode: null,
        shadowRoot: null,
        isConnected: false,
        _attrs: {},
        _listeners: {},
        setAttribute(k, v) {
            this._attrs[k] = String(v);
            if (k === 'id') this.id = String(v);
            if (k === 'class') this.className = String(v);
        },
        getAttribute(k) {
            return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null;
        },
        append(...kids) {
            kids.forEach((k) => { this.appendChild(k); });
        },
        appendChild(child) {
            if (child && typeof child === 'object') child.parentNode = this;
            this.children.push(child);
            child.isConnected = true;
            return child;
        },
        replaceChildren(...kids) {
            this.children.splice(0, this.children.length);
            this.append(...kids);
        },
        removeChild(child) {
            const i = this.children.indexOf(child);
            if (i >= 0) this.children.splice(i, 1);
            if (child) {
                child.parentNode = null;
                child.isConnected = false;
            }
            return child;
        },
        addEventListener(type, fn) {
            (this._listeners[type] = this._listeners[type] || []).push(fn);
        },
        removeEventListener(type, fn) {
            this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn);
        },
        attachShadow() {
            const root = makeDomNode('shadow-root');
            root.nodeType = 11;
            this.shadowRoot = root;
            return root;
        },
        classList: {
            toggle() {}, add() {}, remove() {},
            contains() { return false; },
        },
        focus() {},
        select() {},
        click() {},
        remove() {},
        querySelector: () => null,
        querySelectorAll: () => [],
        closest: () => null,
    };
    return node;
}

function makeDoc({ nodes = {}, scalars = {}, errors = [], baseURI = BASE } = {}) {
    const doc = {
        baseURI,
        evaluateCalls: [],
        documentElement: makeElement('html', {}, {}),
        evaluate(expr, ctx, ns, type) {
            doc.evaluateCalls.push(type);
            if (errors.indexOf(expr) >= 0) {
                throw new Error("The string '" + expr + "' is not a valid XPath expression.");
            }
            if (type === XPathResult.ORDERED_NODE_SNAPSHOT_TYPE) {
                if (!Object.prototype.hasOwnProperty.call(nodes, expr)) {
                    throw new Error('The result is not a node set');
                }
                const list = nodes[expr];
                return {
                    snapshotLength: list.length,
                    snapshotItem: (i) => list[i] || null,
                };
            }
            if (type === XPathResult.ANY_TYPE) {
                if (Object.prototype.hasOwnProperty.call(scalars, expr)) {
                    const s = scalars[expr];
                    return {
                        resultType: s.type,
                        numberValue: s.value,
                        stringValue: s.value,
                        booleanValue: s.value,
                    };
                }
                const list = Object.prototype.hasOwnProperty.call(nodes, expr) ? nodes[expr] : [];
                let i = 0;
                return {
                    resultType: XPathResult.UNORDERED_NODE_ITERATOR_TYPE,
                    iterateNext: () => list[i++] || null,
                };
            }
            throw new Error('unsupported result type');
        },
        createElement: (tag) => makeDomNode(tag),
        createTextNode: (text) => ({ nodeType: 3, textContent: String(text), nodeValue: String(text) }),
        body: null,
        addEventListener() {},
        removeEventListener() {},
        querySelector: () => null,
        querySelectorAll: () => [],
    };
    return doc;
}

/* ---------------- 脚本加载沙箱 ---------------- */

const menuCalls = [];

function loadScript({ url, doc, withMenu = true, isIframe = false }) {
    const u = new URL(url);
    const win = {
        __intervals: [],
        __listeners: [],
        setInterval(fn, ms) {
            win.__intervals.push({ fn, ms });
            return win.__intervals.length;
        },
        clearInterval() {},
        setTimeout: () => 0,
        clearTimeout() {},
        addEventListener(...args) { win.__listeners.push(args); },
        removeEventListener() {},
        open: () => null,
        alert: () => {},
        innerWidth: 1280,
        innerHeight: 800,
        isSecureContext: false,
        navigator: { clipboard: null },
    };
    win.top = isIframe ? {} : win;
    win.self = win;

    const loc = {
        href: url,
        host: u.host,
        hostname: u.hostname,
        pathname: u.pathname,
        search: u.search,
        hash: u.hash || '',
    };
    win.location = loc;

    doc.body = makeDomNode('body');
    doc.body.isConnected = true;

    global.window = win;
    global.document = doc;
    global.location = loc;
    // Node >= 21 内置 navigator getter，必须用 defineProperty 覆盖
    Object.defineProperty(global, 'navigator', {
        value: win.navigator,
        configurable: true,
        writable: true,
    });
    global.GM_getValue = () => undefined;
    global.GM_setValue = () => {};
    if (withMenu) {
        global.GM_registerMenuCommand = (name, fn) => {
            menuCalls.push({ name, fn });
        };
    } else {
        delete global.GM_registerMenuCommand;
    }
    delete global.__xpathExtractorTestHooks;

    // 脚本内以全局裸标识符调用 setInterval（真实浏览器即 window.setInterval），
    // 必须拦截 Node 全局，否则单测进程会因真实定时器挂起。
    const origSetInterval = global.setInterval;
    const origClearInterval = global.clearInterval;
    global.setInterval = (fn, ms) => {
        win.__intervals.push({ fn, ms });
        return win.__intervals.length;
    };
    global.clearInterval = () => {};
    try {
        new Function('window', 'document', 'location', 'GM_getValue', 'GM_setValue', src)(
            win, doc, loc, global.GM_getValue, global.GM_setValue
        );
    } finally {
        global.setInterval = origSetInterval;
        global.clearInterval = origClearInterval;
    }

    return {
        win,
        doc,
        hooks: global.__xpathExtractorTestHooks,
        menuCalls,
        intervals: win.__intervals,
        listeners: win.__listeners,
        bodyChildren: doc.body.children,
    };
}

/* ---------------- 测试用节点集合 ---------------- */

const a1 = makeElement('a', {
    href: '/a/b?x=1', title: 'T1', 'data-id': 'D1', class: 'link', id: 'a1',
}, {
    textContent: ' A ', innerText: 'A', href: 'https://example.com/dir/a/b?x=1',
});
const a2 = makeElement('a', { href: 'https://example.org/x' }, {
    textContent: ' B ', innerText: 'B', href: 'https://example.org/x',
});
const aWeird = makeElement('a', { href: 'a"b', class: 'weird' }, {
    textContent: 'x,y', innerText: 'x,y',
});
const img = makeElement('img', { src: '/img/p.png' });
const input = makeElement('input', { type: 'text' }, { value: 'hello' });
const div = makeElement('div', { id: 'main', class: 'box red' }, {
    textContent: 'div text',
    innerHTML: '<b>x</b>',
    outerHTML: '<div id="main"><b>x</b></div>',
});
const attrNodes = [
    { nodeType: 2, nodeValue: '/a/b?x=1', name: 'href', ownerElement: a1 },
    { nodeType: 2, nodeValue: 'https://example.org/x', name: 'href', ownerElement: a2 },
];
const srcAttrNode = { nodeType: 2, nodeValue: '/img/p.png', name: 'src', ownerElement: img };
const textNodes = [
    { nodeType: 3, nodeValue: ' A ' },
    { nodeType: 3, nodeValue: ' B ' },
];

const NODES = {
    '//a': [a1, a2],
    '//a[@class="weird"]': [aWeird],
    '//a/@href': attrNodes,
    '//img/@src': [srcAttrNode],
    '//a/text()': textNodes,
    '//img': [img],
    '//input': [input],
    '//div[@id="main"]': [div],
    '//none': [],
};
const SCALARS = {
    'count(//a)': { type: XPathResult.NUMBER_TYPE, value: 2 },
    'string(//a/@href)': { type: XPathResult.STRING_TYPE, value: '/a/b?x=1' },
    'boolean(//a)': { type: XPathResult.BOOLEAN_TYPE, value: true },
};
const ERRORS = ['//[', 'not('];

const loaded = loadScript({
    url: 'https://example.com/dir/page.html',
    doc: makeDoc({ nodes: NODES, scalars: SCALARS, errors: ERRORS }),
});
const H = loaded.hooks;

function extract(xpath, options) {
    return H.extractByXPath(xpath, options || {}, loaded.doc);
}

function fmt(xpath, extractOpts, fmtOpts) {
    return H.formatResults(extract(xpath, extractOpts), fmtOpts || {});
}

// 直接对字符串/行数组做格式化（不经过 XPath）
function fmtRows(rows, options) {
    return H.formatResults(rows, options || {});
}

/* ================================================================
 * 1. 元数据、最小权限与安全隐私审计
 * ================================================================ */

check('元数据：名称 / 版本 / 许可证 / 命名空间齐全', () => {
    assert(/^\/\/ @name\s+XPath DOM Attribute Extractor$/m.test(src), '缺少英文 @name');
    assert(/^\/\/ @name:zh-CN\s+\S+/m.test(src), '缺少中文 @name:zh-CN');
    assert(/^\/\/ @description\s+\S+/m.test(src), '缺少英文 @description');
    assert(/^\/\/ @description:zh-CN\s+\S+/m.test(src), '缺少中文 @description:zh-CN');
    assert(/^\/\/ @author\s+\S+/m.test(src), '缺少 @author');
    assert(/^\/\/ @namespace\s+https:\/\/github\.com\/\S+$/m.test(src), '@namespace 应指向公开仓库');
    assert(/^\/\/ @license\s+MIT$/m.test(src), '@license 应为 MIT');
    assert(/^\/\/ @version\s+\d+\.\d+\.\d+$/m.test(src), '@version 应为 SemVer');
    assert(/^\/\/ @run-at\s+document-end$/m.test(src), '@run-at 应为 document-end');
});

check('最小权限：仅 @match *://*/* 与三个本地/菜单 @grant', () => {
    const matches = src.match(/^\/\/ @match\s+.*$/gm) || [];
    eq(matches.length, 1, '应只有一条 @match');
    assert(/^\/\/ @match\s+\*:\/\/\*\/\*$/.test(matches[0]), '@match 应为 *://*/*');
    assert(!/^\/\/ @include/m.test(src), '不应出现 @include');

    const grants = (src.match(/^\/\/ @grant\s+(\S+)\s*$/gm) || [])
        .map((line) => line.replace(/^\/\/ @grant\s+/, '').trim());
    eq(grants.length, 3, '@grant 应恰好三条，实际：' + grants.join(','));
    eq(grants.join(','), 'GM_getValue,GM_setValue,GM_registerMenuCommand');

    assert(!/^\/\/ @connect/m.test(src), '不应声明 @connect');
    assert(!/^\/\/ @resource/m.test(src), '不应声明 @resource');
    assert(src.indexOf('GM' + '.xmlHttpRequest') < 0, '不应使用 GM 跨域请求 API');
});

check('最小权限：代码内无任何网络请求能力', () => {
    const banned = [
        new RegExp('XML' + 'HttpRequest'),
        new RegExp('\\b' + 'fe' + 'tch' + '\\s*\\('),
        new RegExp('send' + 'Beacon'),
        new RegExp('Web' + 'Socket'),
    ];
    banned.forEach((re, i) => {
        assert(!re.test(src), '代码内不应出现网络请求能力 #' + i);
    });
});

check('更新入口：@namespace / updateURL / downloadURL / homepage / support 指向公开仓库', () => {
    const repo = 'Traveler0014/tampermonkey-xpath-extractor';
    const raw = 'https://raw.githubusercontent.com/' + repo + '/main/xpath-extractor.user.js';
    const home = 'https://github.com/' + repo;
    assert(src.indexOf('// @namespace    ' + home) >= 0, '@namespace 异常');
    assert(src.indexOf('// @updateURL    ' + raw) >= 0, '@updateURL 异常');
    assert(src.indexOf('// @downloadURL  ' + raw) >= 0, '@downloadURL 异常');
    assert(src.indexOf('// @homepageURL  ' + home) >= 0, '@homepageURL 异常');
    assert(src.indexOf('// @supportURL   ' + home + '/issues') >= 0, '@supportURL 异常');
    assert(/^\/\/ @homepageURL\s+https:\/\/github\.com\/Traveler0014\/tampermonkey-xpath-extractor$/m.test(src),
        '@homepageURL 正则未命中');
    // 安装链接与脚本元数据必须指向同一仓库，避免自动更新 404
    assert(readmeSrc.indexOf('](' + raw + ')') >= 0, 'README 一键安装链接与 @downloadURL 不一致');
});

check('安全审计：用户脚本仅引用公开主机、零 IPv4、零邮箱、零网络请求 API', () => {
    const problems = auditText('用户脚本', src, SCRIPT_HOSTS);
    eq(problems.join('; '), '', problems.join('; '));
});

check('安全审计：测试脚本自身同样满足全部约束', () => {
    const problems = auditText('测试脚本', selfSrc, TEST_HOSTS);
    eq(problems.join('; '), '', problems.join('; '));
});

check('安全审计：仓库 README 无私有主机 / IP / 邮箱', () => {
    const problems = auditText('README', readmeSrc, SCRIPT_HOSTS, { checkApis: false });
    eq(problems.join('; '), '', problems.join('; '));
});

check('命名空间：宿主 ID / 存储键 / 日志前缀 / 测试钩子统一', () => {
    assert(src.indexOf("rootId: 'xpath-extractor-root'") >= 0, '宿主 ID 未统一');
    const keys = ['xpath', 'attr', 'format', 'view', 'options', 'history'];
    keys.forEach((k) => {
        assert(src.indexOf("xpath: 'xpath-extractor:xpath'") >= 0 || src.indexOf(k) >= 0, '缺少存储键 ' + k);
    });
    ['xpath-extractor:xpath', 'xpath-extractor:attr', 'xpath-extractor:format',
        'xpath-extractor:view', 'xpath-extractor:options', 'xpath-extractor:history',
    ].forEach((key) => {
        assert(src.indexOf("'" + key + "'") >= 0, '缺少存储键 ' + key);
    });
    assert(src.indexOf("[XPath Extractor]") >= 0, '日志前缀未统一');
    assert(src.indexOf('__XPATH_EXTRACTOR_TEST__') >= 0, '缺少受控测试开关');
    assert(src.indexOf('__xpathExtractorTestHooks') >= 0, '缺少受控测试钩子');
});

/* ---------------- 2. 默认行为 ---------------- */

check('默认行为：textContent + trim + join("\\n")', () => {
    const r = fmt('//a');
    eq(r.text, 'A\nB');
    eq(r.attrs.length, 1);
    eq(r.attrs[0], 'textContent');
    eq(r.count, 2);
});

check('ORDERED_NODE_SNAPSHOT_TYPE：按文档顺序取节点', () => {
    const r = extract('//a', { attr: 'textContent' });
    assert(r.ok, '提取失败');
    eq(r.kind, 'nodes');
    eq(r.nodeCount, 2);
    eq(r.rows[0].node, a1);
    eq(r.rows[1].node, a2);
});

/* ---------------- 3. 常用与自定义属性 ---------------- */

check('HTML 属性：href / src / title / id / class / data-*，缺失属性跳过', () => {
    eq(fmt('//a', { attr: 'href' }).text, '/a/b?x=1\nhttps://example.org/x', 'href');
    eq(fmt('//img', { attr: 'src' }).text, '/img/p.png', 'src');
    eq(fmt('//a', { attr: 'title' }).text, 'T1', 'title（a2 无则跳过）');
    eq(fmt('//a', { attr: 'id' }).text, 'a1', 'id');
    eq(fmt('//a', { attr: 'class' }).text, 'link', 'class');
    eq(fmt('//a', { attr: 'data-id' }).text, 'D1', 'data-*');
    const missing = fmt('//img', { attr: 'alt' });
    eq(missing.count, 0, '缺失属性应跳过');
    eq(missing.text, '');
});

check('内置属性：innerText / innerHTML / outerHTML / value / tagName / prop.href', () => {
    eq(fmt('//a', { attr: 'innerText' }).text, 'A\nB');
    eq(fmt('//div[@id="main"]', { attr: 'innerHTML' }).text, '<b>x</b>');
    eq(fmt('//div[@id="main"]', { attr: 'outerHTML' }).text, '<div id="main"><b>x</b></div>');
    eq(fmt('//input', { attr: 'value' }).text, 'hello');
    eq(fmt('//div[@id="main"]', { attr: 'tagName' }).text, 'div');
    eq(fmt('//a', { attr: 'prop.href' }).text,
        'https://example.com/dir/a/b?x=1\nhttps://example.org/x');
});

check('属性名兜底：attr 为 ", ," 或空白时按 textContent 提取', () => {
    const r = fmt('//a', { attr: ', ,' });
    eq(r.attrs.join(','), 'textContent');
    eq(r.text, 'A\nB');
    eq(fmt('//a', { attr: '   ' }).text, 'A\nB', '纯空白兜底');
});

/* ---------------- 4. 相对 URL 补全 ---------------- */

check('相对 URL 补全：resolveUrl=true 用 baseURI 转绝对，false 保留原值', () => {
    eq(fmt('//a', { attr: 'href' }).text, '/a/b?x=1\nhttps://example.org/x', 'resolveUrl=false');
    eq(fmt('//a', { attr: 'href', resolveUrl: true }).text,
        'https://example.com/a/b?x=1\nhttps://example.org/x', 'resolveUrl=true');
    eq(fmt('//img', { attr: 'src', resolveUrl: true }).text,
        'https://example.com/img/p.png', 'src 补全');
});

check('相对 URL 补全：Attr 节点（//a/@href、//img/@src）同样支持 resolveUrl', () => {
    eq(fmt('//a/@href', { attr: 'href' }).text, '/a/b?x=1\nhttps://example.org/x', '未勾选保留原值');
    eq(fmt('//a/@href', { attr: 'href', resolveUrl: true }).text,
        'https://example.com/a/b?x=1\nhttps://example.org/x', 'Attr 节点按 ownerElement.baseURI 补全');
    eq(fmt('//img/@src', { attr: 'src', resolveUrl: true }).text,
        'https://example.com/img/p.png', 'src Attr 节点补全');
});

/* ---------------- 5. 特殊节点与标量 ---------------- */

check('特殊节点：Attr(nodeType=2) / Text(nodeType=3)', () => {
    eq(fmt('//a/@href', { attr: 'href' }).text, '/a/b?x=1\nhttps://example.org/x', 'Attr 节点');
    eq(fmt('//a/text()').text, 'A\nB', 'Text 节点');
});

check('标量 XPath：number / string / boolean', () => {
    const n = fmt('count(//a)');
    eq(n.text, '2');
    eq(extract('count(//a)').kind, 'scalar');
    eq(fmt('string(//a/@href)').text, '/a/b?x=1');
    eq(fmt('boolean(//a)').text, 'true');
});

/* ---------------- 6. 多属性与格式化 ---------------- */

check('多属性：TSV 每行 tab 拼接并带表头', () => {
    const r = fmt('//a', { attr: 'textContent, href' }, { format: 'tsv' });
    eq(r.text, 'textContent\thref\nA\t/a/b?x=1\nB\thttps://example.org/x');
    eq(r.attrs.join(','), 'textContent,href');
});

check('多属性：CSV 标准转义（含逗号 / 引号）', () => {
    const normal = fmt('//a', { attr: 'textContent, href' }, { format: 'csv' });
    eq(normal.text, 'textContent,href\nA,/a/b?x=1\nB,https://example.org/x');
    const weird = fmt('//a[@class="weird"]', { attr: 'textContent, href' }, { format: 'csv' });
    eq(weird.text, 'textContent,href\n"x,y","a""b"');
    eq(fmtRows(['a,b', 'c"d'], { format: 'csv' }).text, '"a,b"\n"c""d"');
});

check('多属性：JSON 输出对象数组', () => {
    const r = fmt('//a', { attr: 'textContent, href' }, { format: 'json' });
    const arr = JSON.parse(r.text);
    eq(arr.length, 2);
    eq(arr[0].textContent, 'A');
    eq(arr[0].href, '/a/b?x=1');
    eq(arr[1].href, 'https://example.org/x');
});

check('单属性其它格式：comma / tsv / json', () => {
    eq(fmt('//a', {}, { format: 'comma' }).text, 'A, B');
    eq(fmt('//a', {}, { format: 'tsv' }).text, 'A\nB');
    eq(fmtRows(['a', 'b'], { format: 'json' }).text, '[\n  "a",\n  "b"\n]');
});

/* ---------------- 7. 选项组合 ---------------- */

check('选项：trim=false 保留首尾空格', () => {
    eq(fmt('//a', {}, { trim: false }).text, ' A \n B ');
});

check('选项：skipEmpty=false 保留空值', () => {
    eq(fmtRows(['a', '', 'b'], { skipEmpty: false }).text, 'a\n\nb');
    eq(fmtRows(['a', '', 'b'], { skipEmpty: false }).count, 3);
    eq(fmtRows(['a', '', 'b']).text, 'a\nb', '默认跳过空值');
});

check('选项：dedupe 保序去重', () => {
    eq(fmtRows(['a', 'b', 'a', ' a '], { dedupe: true }).text, 'a\nb');
});

check('选项：关键词 filter 忽略大小写', () => {
    eq(fmtRows(['foo', 'Bar', 'baz'], { filter: 'ba' }).text, 'Bar\nbaz');
    eq(fmtRows(['foo', 'Bar', 'baz'], { filter: 'BA' }).text, 'Bar\nbaz');
});

check('选项：多属性 skipEmpty 仅跳过整行为空', () => {
    const rows = [
        { values: ['', ''] },
        { values: ['', 'x'] },
    ];
    eq(H.formatResults(rows, { format: 'tsv', attrs: ['a', 'b'] }).text, 'a\tb\n\tx');
});

/* ---------------- 8. 异常输入 ---------------- */

check('异常：空 XPath 返回结构化错误', () => {
    const r = extract('');
    eq(r.ok, false);
    assert(/不能为空/.test(r.error), '错误信息应包含「不能为空」');
    eq(extract('   ').ok, false);
});

check('异常：语法错误 XPath 返回结构化错误而非未捕获异常', () => {
    const r = extract('//[');
    eq(r.ok, false);
    assert(/XPath 语法错误/.test(r.error), '错误信息应包含「XPath 语法错误」，实际：' + r.error);
});

check('evaluateXPath：快照空节点集不再二次 ANY_TYPE 求值', () => {
    const doc = loaded.doc;
    doc.evaluateCalls = [];
    const r = H.evaluateXPath('//none', doc);
    eq(r.ok, true);
    eq(r.kind, 'nodes');
    eq(r.nodes.length, 0);
    eq(doc.evaluateCalls.length, 1, '空节点集只应调用一次 evaluate');
    eq(doc.evaluateCalls[0], XPathResult.ORDERED_NODE_SNAPSHOT_TYPE);
});

/* ---------------- 9. 元素拾取：XPath 生成 ---------------- */

check('元素拾取：id 锚点生成简短唯一 XPath', () => {
    const target = makeElement('div', {}, { id: 'main' });
    eq(H.generateXPath(target), '//*[@id="main"]');
});

check('元素拾取：无 id 时按同名兄弟序号逐级拼接', () => {
    const docEl = makeElement('html', {}, {});
    const body = makeElement('body', {}, {});
    const ul = makeElement('ul', {}, {});
    const li1 = makeElement('li', {}, {});
    const li2 = makeElement('li', {}, {});
    docEl.children = [body];
    body.parentElement = docEl;
    body.children = [ul];
    ul.parentElement = body;
    ul.children = [li1, li2];
    li1.parentElement = ul;
    li2.parentElement = ul;
    const prev = loaded.doc.documentElement;
    loaded.doc.documentElement = docEl;
    try {
        eq(H.generateXPath(li2), '/html/body/ul/li[2]');
        eq(H.generateXPath(docEl), '/html');
    } finally {
        loaded.doc.documentElement = prev;
    }
});

/* ---------------- 10. 作用域与零侵入 ---------------- */

check('作用域：普通页面零 DOM 注入、零定时轮询、仅注册 1 个菜单命令', () => {
    const before = menuCalls.length;
    const r = loadScript({
        url: 'https://example.com/page',
        doc: makeDoc({ nodes: {}, scalars: {} }),
    });
    assert(r.hooks, '测试钩子未暴露');
    eq(r.bodyChildren.length, 0, '加载时不应向 body 挂载任何 DOM');
    eq(r.intervals.length, 0, '不应启动任何定时轮询');
    eq(menuCalls.length - before, 1, '应注册 1 个油猴菜单命令');
    eq(menuCalls[menuCalls.length - 1].name, 'XPath 属性提取器');
});

check('作用域：快捷键监听已注册（capture 阶段 keydown）', () => {
    const r = loadScript({ url: 'https://example.com/page', doc: makeDoc() });
    const hit = r.listeners.filter((a) => a[0] === 'keydown' && a[2] === true);
    eq(hit.length, 1, 'window 上应有且仅有一个 capture keydown 监听');
});

check('零侵入：菜单唤起才挂载 Shadow DOM，关闭后完全卸载', () => {
    const r = loadScript({ url: 'https://example.com/page', doc: makeDoc() });
    eq(r.bodyChildren.length, 0, '唤起前不应有 DOM');
    menuCalls[menuCalls.length - 1].fn();
    eq(r.bodyChildren.length, 1, '唤起后应挂载 1 个宿主元素');
    const host = r.bodyChildren[0];
    eq(host.getAttribute('id'), 'xpath-extractor-root');
    assert(host.shadowRoot, '应使用 Shadow DOM 隔离样式与结构');
    assert(host.shadowRoot.children.length >= 1, 'Shadow 根应包含样式与界面');
    r.hooks.xpathExtractor.close();
    eq(r.bodyChildren.length, 0, '关闭后应完全移除宿主元素');
});

check('作用域：无 GM_registerMenuCommand 时不抛异常', () => {
    const r = loadScript({
        url: 'https://example.com/page',
        doc: makeDoc(),
        withMenu: false,
    });
    assert(r.hooks, '无菜单 API 时脚本应继续运行');
    eq(r.intervals.length, 0);
    eq(r.bodyChildren.length, 0);
});

check('作用域：iframe 内不激活（不注入 DOM、不注册菜单）', () => {
    const before = menuCalls.length;
    const r = loadScript({
        url: 'https://example.com/embed',
        doc: makeDoc(),
        isIframe: true,
    });
    eq(r.hooks, undefined, 'iframe 内不应初始化');
    eq(r.bodyChildren.length, 0);
    eq(menuCalls.length - before, 0, 'iframe 内不应注册菜单');
});

/* ---------------- 汇总 ---------------- */

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
