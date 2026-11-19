// ==UserScript==
// @name         XPath DOM Attribute Extractor
// @name:zh-CN   XPath DOM 属性提取器
// @namespace    https://github.com/Traveler0014/tampermonkey-xpath-extractor
// @version      1.0.0
// @description  Extract DOM element attributes (textContent, href, src, data-*, multi-attribute) on any webpage via XPath with a zero-intrusion Shadow DOM modal, element picker, page highlight, and copy-ready formats (text/CSV/TSV/JSON).
// @description:zh-CN 任意网页通过 XPath 提取 DOM 元素指定属性（支持 textContent/href/src/data-*/多属性、相对 URL 补全、换行/逗号/TSV/CSV/JSON、元素拾取与页面高亮），默认零 DOM 注入
// @author       Traveler0014
// @license      MIT
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @updateURL    https://raw.githubusercontent.com/Traveler0014/tampermonkey-xpath-extractor/main/xpath-extractor.user.js
// @downloadURL  https://raw.githubusercontent.com/Traveler0014/tampermonkey-xpath-extractor/main/xpath-extractor.user.js
// @homepageURL  https://github.com/Traveler0014/tampermonkey-xpath-extractor
// @supportURL   https://github.com/Traveler0014/tampermonkey-xpath-extractor/issues
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    /* ================================
     * 配置：所有常量集中在此处
     * ================================ */
    const CONFIG = {
        XPATH_EXTRACTOR: {
            rootId: 'xpath-extractor-root',
            historyLimit: 8, // 最近使用的 XPath 条数
            // 快捷属性芯片（Shift+点击追加为多属性）
            quickAttrs: ['textContent', 'innerText', 'href', 'src', 'title', 'value', 'id', 'class', 'innerHTML', 'outerHTML'],
            formats: [
                { key: 'newline', label: '换行(\\n)', ext: 'txt' },
                { key: 'comma', label: '逗号(,)', ext: 'txt' },
                { key: 'tsv', label: 'TSV(Excel)', ext: 'tsv' },
                { key: 'csv', label: 'CSV', ext: 'csv' },
                { key: 'json', label: 'JSON', ext: 'json' },
            ],
            storage: {
                xpath: 'xpath-extractor:xpath',
                attr: 'xpath-extractor:attr',
                format: 'xpath-extractor:format',
                view: 'xpath-extractor:view',
                options: 'xpath-extractor:options',
                history: 'xpath-extractor:history',
            },
        },
    };

    /* ================================
     * 通用工具（仅本地能力，无任何网络请求）
     * ================================ */
    const log = (...args) => console.debug('[XPath Extractor]', ...args);

    // GM 存储封装（沙箱外降级 localStorage，便于调试）
    const storage = {
        get(key, def) {
            let v;
            try { v = GM_getValue(key); } catch (e) { v = undefined; }
            if (v === undefined) { try { v = localStorage.getItem(key); } catch (e) { v = null; } }
            return v == null || v === '' ? def : v;
        },
        set(key, val) {
            try { GM_setValue(key, val); return; } catch (e) { /* noop */ }
            try { localStorage.setItem(key, val); } catch (e) { /* noop */ }
        },
    };

    // 触发浏览器保存 Blob 为文件
    function saveBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 1000);
    }

    // 复制文本：优先 Clipboard API，降级 execCommand（兼容非 HTTPS 环境）
    async function copyText(text) {
        if (navigator.clipboard && window.isSecureContext) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch (e) { /* 降级 */ }
        }
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return ok;
        } catch (e) {
            return false;
        }
    }

    /* ================================
     * 核心：任意网页 XPath DOM 属性提取器（Shadow DOM 模态框，按需懒挂载）
     * - 零侵入：任意网页默认不注入任何 DOM，仅通过油猴菜单 / Alt+Shift+X 唤起
     * - 引擎与 UI 分离：extractByXPath（XPath 求值 + 属性提取）→ formatResults（清洗 + 格式化）
     * ================================ */
    const xpathExtractor = (() => {
        const CFG = CONFIG.XPATH_EXTRACTOR;
        const STORE = CFG.storage;

        // XPathResult 常量（Node 单测无原生 XPathResult 时回退；数值与浏览器规范一致）
        const XR_FALLBACK = {
            ANY_TYPE: 0, NUMBER_TYPE: 1, STRING_TYPE: 2, BOOLEAN_TYPE: 3,
            UNORDERED_NODE_ITERATOR_TYPE: 4, ORDERED_NODE_ITERATOR_TYPE: 5,
            UNORDERED_NODE_SNAPSHOT_TYPE: 6, ORDERED_NODE_SNAPSHOT_TYPE: 7,
            ANY_UNORDERED_NODE_TYPE: 8, FIRST_ORDERED_NODE_TYPE: 9,
        };
        const xr = () => (typeof XPathResult !== 'undefined' && XPathResult) || XR_FALLBACK;

        /* ---------------- 引擎：提取 ---------------- */

        function normalizeOptions(options) {
            const o = options || {};
            return {
                attr: o.attr == null || o.attr === '' ? 'textContent' : String(o.attr),
                trim: o.trim !== undefined ? !!o.trim : true,
                skipEmpty: o.skipEmpty !== undefined ? !!o.skipEmpty : true,
                dedupe: !!o.dedupe,
                resolveUrl: !!o.resolveUrl,
                filter: o.filter == null ? '' : String(o.filter),
                format: o.format || 'newline',
                header: o.header !== false,
                attrs: Array.isArray(o.attrs) ? o.attrs.slice() : null,
            };
        }

        // 逗号分隔多属性：'textContent, href' → ['textContent', 'href']
        function parseAttrList(attr) {
            return String(attr == null ? '' : attr)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
        }

        // 相对 URL 补全：非法/无 base 时回退原值
        function resolveUrl(raw, baseURI) {
            if (raw == null || raw === '') return raw == null ? null : '';
            try {
                return new URL(String(raw), baseURI || undefined).href;
            } catch (e) {
                return String(raw);
            }
        }

        function getAttr(node, name) {
            try {
                if (typeof node.hasAttribute === 'function' && node.hasAttribute(name)) {
                    const v = node.getAttribute(name);
                    return v == null ? null : String(v);
                }
            } catch (e) { /* noop */ }
            return null;
        }

        // 单节点单属性提取：支持 Attr/Text 节点、内置 DOM 属性、prop.<name>、任意 HTML 属性
        function extractNodeAttr(node, attr, options) {
            const o = options || {};
            const name = String(attr == null ? '' : attr).trim();
            if (!node || !name) return null;

            const type = node.nodeType;
            if (type === 2) { // Attr 节点：nodeValue 即属性值；resolveUrl 对 href/src 同样生效
                const val = node.nodeValue == null ? null : String(node.nodeValue);
                if (val != null && o.resolveUrl) {
                    const attrName = node.name || name;
                    if (attrName === 'href' || attrName === 'src' || name === 'href' || name === 'src') {
                        const base = (node.ownerElement && node.ownerElement.baseURI) || o.baseURI;
                        return resolveUrl(val, base);
                    }
                }
                return val;
            }
            if (type === 3) { // Text 节点
                return node.nodeValue == null ? null : String(node.nodeValue);
            }
            if (type !== 1) {
                return node.nodeValue == null ? null : String(node.nodeValue);
            }

            // 显式 JS 属性：prop.href / prop.dataset 等
            if (name.indexOf('prop.') === 0) {
                const prop = name.slice(5);
                if (!prop) return null;
                const v = node[prop];
                if (v == null || typeof v === 'object' || typeof v === 'function') return null;
                return String(v);
            }

            switch (name) {
                case 'textContent':
                    return node.textContent == null ? null : String(node.textContent);
                case 'innerText':
                    return (node.innerText != null ? node.innerText : node.textContent) == null
                        ? null : String(node.innerText != null ? node.innerText : node.textContent);
                case 'innerHTML':
                    return node.innerHTML == null ? null : String(node.innerHTML);
                case 'outerHTML':
                    return node.outerHTML == null ? null : String(node.outerHTML);
                case 'value':
                    if (typeof node.value === 'string') return node.value;
                    if (node.value != null) return String(node.value);
                    return getAttr(node, 'value');
                case 'tagName':
                    return node.tagName ? String(node.tagName).toLowerCase() : null;
                default:
                    break;
            }

            // 任意 HTML 属性（href/src/title/id/class/name/alt/data-*/aria-* …）
            let raw = getAttr(node, name);
            if (raw == null && name in node) {
                const v = node[name];
                if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') raw = String(v);
            }
            if (raw == null) return null;
            if (o.resolveUrl && (name === 'href' || name === 'src')) {
                return resolveUrl(raw, node.baseURI || o.baseURI);
            }
            return raw;
        }

        // XPath 求值：优先 ORDERED_NODE_SNAPSHOT_TYPE（按文档顺序返回），标量结果回退 ANY_TYPE
        function evaluateXPath(xpath, doc) {
            const expr = xpath == null ? '' : String(xpath).trim();
            if (!expr) return { ok: false, error: 'XPath 不能为空' };
            const docNode = doc || (typeof document !== 'undefined' ? document : null);
            if (!docNode || typeof docNode.evaluate !== 'function') {
                return { ok: false, error: '当前环境不支持 XPath（document.evaluate 不可用）' };
            }
            const X = xr();
            let snap = null;
            try {
                snap = docNode.evaluate(expr, docNode, null, X.ORDERED_NODE_SNAPSHOT_TYPE, null);
            } catch (e) {
                return evalAnyType(expr, docNode, X);
            }
            const nodes = snapshotToArray(snap);
            // 快照求值成功：空节点集是合法结果，直接返回（标量在浏览器中会抛 TYPE_ERR 走 catch）
            return { ok: true, kind: 'nodes', nodes };
        }

        function snapshotToArray(snap) {
            const nodes = [];
            if (!snap || typeof snap.snapshotLength !== 'number') return nodes;
            for (let i = 0; i < snap.snapshotLength; i++) {
                let n = null;
                try { n = snap.snapshotItem(i); } catch (e) { n = null; }
                if (n) nodes.push(n);
            }
            return nodes;
        }

        function evalAnyType(expr, docNode, X) {
            let res;
            try {
                res = docNode.evaluate(expr, docNode, null, X.ANY_TYPE, null);
            } catch (e) {
                return { ok: false, error: 'XPath 语法错误：' + cleanErr(e) };
            }
            if (!res || typeof res.resultType !== 'number') {
                return { ok: false, error: 'XPath 求值失败' };
            }
            switch (res.resultType) {
                case X.NUMBER_TYPE:
                    return { ok: true, kind: 'scalar', scalar: res.numberValue, scalarType: 'number' };
                case X.STRING_TYPE:
                    return { ok: true, kind: 'scalar', scalar: res.stringValue, scalarType: 'string' };
                case X.BOOLEAN_TYPE:
                    return { ok: true, kind: 'scalar', scalar: res.booleanValue, scalarType: 'boolean' };
                default: {
                    const nodes = [];
                    if (typeof res.iterateNext === 'function') {
                        let guard = 0;
                        let n;
                        while ((n = res.iterateNext()) && guard++ < 200000) nodes.push(n);
                    }
                    return { ok: true, kind: 'nodes', nodes };
                }
            }
        }

        function cleanErr(e) {
            return e && e.message ? String(e.message) : String(e);
        }

        // 提取引擎：options = { attr, resolveUrl }
        function extractByXPath(xpath, options, doc) {
            const opts = normalizeOptions(options);
            const docNode = doc || (typeof document !== 'undefined' ? document : null);
            let attrs = parseAttrList(opts.attr);
            if (!attrs.length) attrs = ['textContent']; // 如 attr 为 ', ,' / 空白时兜底
            const baseURI = (docNode && docNode.baseURI)
                || (typeof location !== 'undefined' && location ? location.href : '');
            const ev = evaluateXPath(xpath, docNode);
            if (!ev.ok) return ev;

            if (ev.kind === 'scalar') {
                const val = ev.scalar == null ? '' : String(ev.scalar);
                return {
                    ok: true, kind: 'scalar', scalarType: ev.scalarType,
                    attrs: [attrs[0] || 'textContent'],
                    rows: [{ node: null, values: [val] }],
                    nodeCount: 1, count: 1,
                };
            }

            const rows = ev.nodes.map((node) => ({
                node,
                values: attrs.map((a) => extractNodeAttr(node, a, { resolveUrl: opts.resolveUrl, baseURI })),
            }));
            return { ok: true, kind: 'nodes', attrs, rows, nodeCount: ev.nodes.length, count: rows.length };
        }

        /* ---------------- 引擎：清洗 + 格式化 ---------------- */

        function csvCell(value) {
            const s = value == null ? '' : String(value);
            if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
            return s;
        }

        function tsvCell(value) {
            return (value == null ? '' : String(value)).replace(/[\t\r\n]+/g, ' ');
        }

        function headerLabel(attr) {
            return String(attr == null ? '' : attr);
        }

        // input 可为 extractByXPath 的结果对象，或 rows 数组；options 控制清洗与格式
        function formatResults(input, options) {
            const opts = normalizeOptions(options);
            let attrs = null;
            let rawRows = [];
            if (Array.isArray(input)) {
                rawRows = input;
            } else if (input && Array.isArray(input.rows)) {
                rawRows = input.rows;
                attrs = Array.isArray(input.attrs) ? input.attrs.slice() : null;
            } else {
                return { ok: false, error: '无可用结果' };
            }

            const rows = rawRows.map((r) => {
                const values = Array.isArray(r) ? r : (r && Array.isArray(r.values) ? r.values : [r]);
                return {
                    node: r && !Array.isArray(r) ? r.node : null,
                    values: values.map((v) => (v == null ? '' : String(v))),
                };
            });

            if (!attrs || !attrs.length) {
                if (opts.attrs && opts.attrs.length) {
                    attrs = opts.attrs.slice();
                } else {
                    const firstMulti = rows.find((r) => r.values.length > 1);
                    if (firstMulti) {
                        attrs = firstMulti.values.map((v, i) => 'col' + (i + 1));
                    } else {
                        attrs = ['textContent'];
                    }
                }
            }
            const multi = attrs.length > 1;
            const keyword = opts.filter.trim().toLowerCase();
            const cleaned = [];
            const seen = new Set();

            for (const row of rows) {
                let values = row.values;
                if (opts.trim) values = values.map((v) => v.trim());
                if (keyword && !values.some((v) => v.toLowerCase().indexOf(keyword) >= 0)) continue;
                if (opts.skipEmpty) {
                    if (multi) {
                        if (values.every((v) => v === '')) continue;
                    } else if (values[0] === '') {
                        continue;
                    }
                }
                if (opts.dedupe) {
                    const key = values.join('\u0001');
                    if (seen.has(key)) continue;
                    seen.add(key);
                }
                cleaned.push({ node: row.node, values });
            }

            const headers = attrs.map(headerLabel);
            const fmt = opts.format;
            let text = '';

            if (!multi) {
                const values = cleaned.map((r) => r.values[0]);
                switch (fmt) {
                    case 'comma': text = values.join(', '); break;
                    case 'tsv': text = values.join('\n'); break;
                    case 'csv': text = values.map(csvCell).join('\n'); break;
                    case 'json': text = JSON.stringify(values, null, 2); break;
                    case 'newline':
                    default: text = values.join('\n'); break;
                }
                return {
                    ok: true, text, count: values.length, total: rows.length,
                    rows: cleaned, values, attrs, multi: false, format: fmt,
                };
            }

            switch (fmt) {
                case 'json': {
                    const objs = cleaned.map((r) => {
                        const obj = {};
                        attrs.forEach((a, i) => { obj[headers[i]] = r.values[i] == null ? '' : r.values[i]; });
                        return obj;
                    });
                    text = JSON.stringify(objs, null, 2);
                    break;
                }
                case 'comma':
                case 'csv': {
                    const lines = cleaned.map((r) => r.values.map(csvCell).join(','));
                    if (opts.header) lines.unshift(headers.map(csvCell).join(','));
                    text = lines.join('\n');
                    break;
                }
                case 'tsv':
                case 'newline':
                default: {
                    const lines = cleaned.map((r) => r.values.map(tsvCell).join('\t'));
                    if (opts.header) lines.unshift(headers.map(tsvCell).join('\t'));
                    text = lines.join('\n');
                    break;
                }
            }
            return {
                ok: true, text, count: cleaned.length, total: rows.length,
                rows: cleaned, attrs, multi: true, format: fmt,
            };
        }

        // 单行格式化（列表视图「复制」用）
        function formatRow(values, attrs, format) {
            const vals = (values || []).map((v) => (v == null ? '' : String(v)));
            if (!attrs || attrs.length <= 1) return vals[0] || '';
            switch (format) {
                case 'json': {
                    const obj = {};
                    attrs.forEach((a, i) => { obj[headerLabel(a)] = vals[i] == null ? '' : vals[i]; });
                    return JSON.stringify(obj);
                }
                case 'csv':
                case 'comma':
                    return vals.map(csvCell).join(',');
                default:
                    return vals.map(tsvCell).join('\t');
            }
        }

        /* ---------------- UI 状态 ---------------- */

        const prefs = {
            xpath: '',
            attr: 'textContent',
            format: 'newline',
            view: 'text',
            options: { trim: true, skipEmpty: true, dedupe: false, resolveUrl: false },
            history: [],
        };
        let prefsLoaded = false;
        let opened = false;
        let hostEl = null;
        let shadow = null;
        let ui = null;
        const state = { extraction: null, formatted: null, minimized: false, picker: null, resolveUrl: null };
        let highlightRecords = [];
        let flash = null;
        let flashTimer = null;
        let skipAttrChange = false; // Enter 已手动触发提取时，忽略随后浏览器补发的 change 事件

        const el = (tag, attrs, ...children) => {
            const node = document.createElement(tag);
            if (attrs) {
                for (const k of Object.keys(attrs)) {
                    const v = attrs[k];
                    if (v == null) continue;
                    if (k === 'class') node.className = v;
                    else if (k === 'text') node.textContent = v;
                    else if (k === 'checked') node.checked = !!v;
                    else node.setAttribute(k, v);
                }
            }
            for (const c of children) if (c != null) node.append(c);
            return node;
        };

        function isInHost(node) {
            if (!hostEl || !node) return false;
            if (node === hostEl) return true;
            try { return typeof hostEl.contains === 'function' && hostEl.contains(node); } catch (e) { return false; }
        }

        function loadPrefs() {
            prefsLoaded = true;
            prefs.xpath = String(storage.get(STORE.xpath, '') || '');
            prefs.attr = String(storage.get(STORE.attr, 'textContent') || 'textContent');
            const fmt = String(storage.get(STORE.format, 'newline') || 'newline');
            prefs.format = CFG.formats.some((f) => f.key === fmt) ? fmt : 'newline';
            prefs.view = storage.get(STORE.view, 'text') === 'list' ? 'list' : 'text';

            const defaults = { trim: true, skipEmpty: true, dedupe: false, resolveUrl: false };
            let saved = null;
            try { saved = JSON.parse(storage.get(STORE.options, '') || 'null'); } catch (e) { saved = null; }
            for (const k of Object.keys(defaults)) {
                prefs.options[k] = saved && typeof saved[k] === 'boolean' ? saved[k] : defaults[k];
            }

            let hist = null;
            try { hist = JSON.parse(storage.get(STORE.history, '') || '[]'); } catch (e) { hist = null; }
            prefs.history = Array.isArray(hist)
                ? hist.filter((h) => typeof h === 'string' && h.trim()).slice(0, CFG.historyLimit)
                : [];
        }

        function savePrefs() {
            storage.set(STORE.xpath, prefs.xpath || '');
            storage.set(STORE.attr, prefs.attr || 'textContent');
            storage.set(STORE.format, prefs.format || 'newline');
            storage.set(STORE.view, prefs.view || 'text');
            storage.set(STORE.options, JSON.stringify(prefs.options));
        }

        function readOptions() {
            return {
                trim: ui ? ui.cbTrim.checked : prefs.options.trim,
                skipEmpty: ui ? ui.cbSkip.checked : prefs.options.skipEmpty,
                dedupe: ui ? ui.cbDedupe.checked : prefs.options.dedupe,
                resolveUrl: ui ? ui.cbResolve.checked : prefs.options.resolveUrl,
                filter: ui ? ui.filterInput.value : '',
            };
        }

        function setFormatUI(format) {
            prefs.format = format;
            if (!ui) return;
            for (const key of Object.keys(ui.formatBtns)) {
                ui.formatBtns[key].classList.toggle('active', key === format);
            }
        }

        function setViewUI(view) {
            prefs.view = view === 'list' ? 'list' : 'text';
            if (!ui) return;
            const isList = prefs.view === 'list';
            ui.textView.classList.toggle('active', !isList);
            ui.listView.classList.toggle('active', isList);
            ui.viewTextBtn.classList.toggle('active', !isList);
            ui.viewListBtn.classList.toggle('active', isList);
        }

        function updateChipState() {
            if (!ui) return;
            const list = parseAttrList(ui.attrInput.value);
            for (const name of Object.keys(ui.chipEls)) {
                ui.chipEls[name].classList.toggle('active', list.indexOf(name) >= 0);
            }
        }

        // 属性变更：持久化 + 芯片高亮；若输入框已有 XPath（即使尚未提取）则立即重新提取
        function applyAttrChange() {
            if (!ui) return;
            prefs.attr = ui.attrInput.value.trim() || 'textContent';
            savePrefs();
            updateChipState();
            if (ui.xpathInput.value.trim()) runExtract();
        }

        function rebuildHistory() {
            if (!ui) return;
            const sel = ui.historySel;
            sel.replaceChildren();
            sel.append(el('option', {
                value: '',
                text: prefs.history.length ? '历史(' + prefs.history.length + ')' : '历史',
            }));
            prefs.history.forEach((h, i) => {
                const label = h.length > 46 ? h.slice(0, 43) + '…' : h;
                sel.append(el('option', { value: String(i), text: label, title: h }));
            });
            sel.value = '';
        }

        function pushHistory(xpath) {
            if (!xpath) return;
            prefs.history = [xpath]
                .concat(prefs.history.filter((h) => h !== xpath))
                .slice(0, CFG.historyLimit);
            storage.set(STORE.history, JSON.stringify(prefs.history));
            rebuildHistory();
        }

        function applyPrefsToUI() {
            if (!ui) return;
            ui.badge.textContent = (typeof location !== 'undefined' && location.host) || '';
            ui.badge.title = (typeof location !== 'undefined' && location.href) || '';
            ui.xpathInput.value = prefs.xpath || '';
            ui.attrInput.value = prefs.attr || 'textContent';
            ui.cbTrim.checked = !!prefs.options.trim;
            ui.cbSkip.checked = !!prefs.options.skipEmpty;
            ui.cbDedupe.checked = !!prefs.options.dedupe;
            ui.cbResolve.checked = !!prefs.options.resolveUrl;
            setFormatUI(prefs.format);
            setViewUI(prefs.view);
            updateChipState();
            updateHighlightButton();
            rebuildHistory();
        }

        function setStatus(msg, type) {
            if (!ui) return;
            ui.statusEl.textContent = msg || '';
            ui.statusEl.className = 'status' + (type ? ' ' + type : '');
        }

        function currentText() {
            return state.formatted && state.formatted.ok ? (state.formatted.text || '') : '';
        }

        /* ---------------- 提取 / 格式化 ---------------- */

        function runExtract() {
            if (!ui) return;
            const xpath = ui.xpathInput.value.trim();
            if (!xpath) {
                setStatus('请输入 XPath 表达式', 'error');
                ui.xpathInput.focus();
                return;
            }
            clearFlash();   // 先还原定位闪烁（可能记录的是高亮颜色），再清高亮
            clearHighlight();
            const attr = ui.attrInput.value.trim() || 'textContent';
            const opts = readOptions();
            const result = extractByXPath(xpath, Object.assign({ attr }, opts));
            if (!result.ok) {
                state.extraction = null;
                state.formatted = null;
                ui.textarea.value = '';
                renderList(null, null);
                ui.xpathInput.classList.add('invalid');
                setStatus(result.error || 'XPath 执行失败', 'error');
                return;
            }
            ui.xpathInput.classList.remove('invalid');
            state.extraction = result;
            state.resolveUrl = !!opts.resolveUrl;
            prefs.xpath = xpath;
            prefs.attr = attr;
            savePrefs();
            pushHistory(xpath);
            reFormat();
        }

        function reFormat() {
            if (!ui || !state.extraction) return;
            const opts = readOptions();
            opts.attrs = state.extraction.attrs;
            opts.format = prefs.format;
            const fmt = formatResults(state.extraction, opts);
            state.formatted = fmt;
            if (!fmt.ok) {
                ui.textarea.value = '';
                renderList(null, null);
                setStatus(fmt.error || '格式化失败', 'error');
                return;
            }
            ui.textarea.value = fmt.text || '';
            renderList(state.extraction, fmt);
            const filtered = fmt.total === fmt.count ? '' : '（过滤前 ' + fmt.total + ' 条）';
            setStatus('命中 ' + state.extraction.nodeCount + ' 个节点 · 产出 ' + fmt.count + ' 条' + filtered,
                fmt.count ? 'ok' : '');
        }

        function onOptionsChange() {
            const next = readOptions();
            // resolveUrl 在提取阶段生效（依赖元素 baseURI），变更时需重新求值；其余选项仅重新格式化
            const resolveChanged = !!state.extraction && state.resolveUrl !== !!next.resolveUrl;
            // 只持久化稳定的布尔选项，filter 属于临时输入不写入 STORAGE.options
            prefs.options = {
                trim: next.trim,
                skipEmpty: next.skipEmpty,
                dedupe: next.dedupe,
                resolveUrl: next.resolveUrl,
            };
            savePrefs();
            if (resolveChanged) runExtract();
            else reFormat();
        }

        /* ---------------- 结果视图 ---------------- */

        function cellEl(value) {
            const text = value == null ? '' : String(value);
            const title = text || '（空）';
            if (/^https?:\/\//i.test(text)) {
                const link = el('a', { href: text, target: '_blank', rel: 'noopener noreferrer', text });
                return el('span', { class: 'cell', title }, link);
            }
            return el('span', { class: 'cell', title, text: text || '（空）' });
        }

        async function copyWithFeedback(btn, text) {
            if (!text) {
                setStatus('没有可复制的内容', 'error');
                return;
            }
            const orig = btn.textContent;
            const ok = await copyText(text);
            btn.textContent = ok ? '✓ 已复制' : '✗ 失败';
            if (!ok) setStatus('复制失败，请手动选择文本复制', 'error');
            setTimeout(() => { if (btn) btn.textContent = orig; }, 1200);
        }

        function renderList(ex, fmt) {
            if (!ui) return;
            const attrs = (ex && ex.attrs) || [];
            const rows = (fmt && fmt.rows) || [];
            const multi = attrs.length > 1;

            ui.listHead.replaceChildren();
            ui.listBody.replaceChildren();
            ui.listHead.append(el('span', { class: 'idx', text: '#' }));
            if (attrs.length) {
                attrs.forEach((a) => {
                    ui.listHead.append(el('span', { class: 'cell', text: headerLabel(a) }));
                });
            } else {
                ui.listHead.append(el('span', { class: 'cell', text: '值' }));
            }
            ui.listHead.append(
                el('span', { class: 'row-btn ghost', text: '复制' }),
                el('span', { class: 'row-btn ghost', text: '定位' }));

            if (!rows.length) {
                ui.listBody.append(el('div', {
                    class: 'empty',
                    text: ex ? '没有产出结果（可能被过滤或全部为空）' : '暂无结果',
                }));
                return;
            }

            rows.forEach((row, i) => {
                const rowEl = el('div', { class: 'row' });
                rowEl.append(el('span', { class: 'idx', text: String(i + 1) }));
                const values = multi ? row.values : [row.values[0]];
                values.forEach((v) => rowEl.append(cellEl(v)));

                const copyRow = el('button', { class: 'row-btn', type: 'button', text: '复制', title: '复制本行' });
                copyRow.addEventListener('click', () => {
                    copyWithFeedback(copyRow, formatRow(row.values, attrs, prefs.format));
                });
                rowEl.append(copyRow);

                if (row.node && row.node.nodeType === 1 && typeof row.node.scrollIntoView === 'function') {
                    const locateBtn = el('button', { class: 'row-btn', type: 'button', text: '定位', title: '定位到页面元素' });
                    locateBtn.addEventListener('click', () => locateNode(row.node));
                    rowEl.append(locateBtn);
                } else {
                    rowEl.append(el('span', { class: 'row-btn ghost', text: '定位' }));
                }
                ui.listBody.append(rowEl);
            });
        }

        function printConsole() {
            const text = currentText();
            if (!text) {
                setStatus('没有可打印的内容', 'error');
                return;
            }
            const head = state.extraction ? '[' + state.extraction.nodeCount + ' 个节点]' : '';
            console.log('[XPath 提取结果] ' + head + '\n' + text);
            setStatus('已打印到 Console（F12 查看）', 'ok');
        }

        function exportFile() {
            const text = currentText();
            if (!text) {
                setStatus('没有可导出的内容', 'error');
                return;
            }
            const f = CFG.formats.find((x) => x.key === prefs.format) || CFG.formats[0];
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
            saveBlob(blob, 'xpath-extract-' + stamp + '.' + (f.ext || 'txt'));
            setStatus('已导出文件', 'ok');
        }

        /* ---------------- 页面高亮 / 定位 ---------------- */

        function updateHighlightButton() {
            if (!ui) return;
            const active = highlightRecords.length > 0;
            ui.highlightBtn.textContent = active ? '清除高亮' : '页面高亮';
            ui.highlightBtn.classList.toggle('active', active);
        }

        function clearHighlight() {
            for (const rec of highlightRecords) {
                if (!rec || !rec.el || !rec.el.style) continue;
                rec.el.style.outline = rec.outline;
                rec.el.style.outlineOffset = rec.outlineOffset;
            }
            highlightRecords = [];
            updateHighlightButton();
        }

        function toggleHighlight() {
            if (!ui) return;
            clearFlash(); // 先还原定位闪烁，避免闪烁记录的 outline 叠加到高亮记录
            if (highlightRecords.length) {
                clearHighlight();
                setStatus('已清除页面高亮');
                return;
            }
            const rows = (state.formatted && state.formatted.rows) || [];
            let first = null;
            for (const row of rows) {
                const node = row.node;
                if (!node || node.nodeType !== 1 || !node.style) continue;
                highlightRecords.push({
                    el: node,
                    outline: node.style.outline,
                    outlineOffset: node.style.outlineOffset,
                });
                node.style.outline = '2px solid #4a90e2';
                node.style.outlineOffset = '2px';
                if (!first) first = node;
            }
            if (!highlightRecords.length) {
                setStatus('没有可高亮的元素（标量结果或非元素节点）', 'error');
                return;
            }
            updateHighlightButton();
            if (first && first.scrollIntoView) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
            minimize('已高亮 ' + highlightRecords.length + ' 个元素', '恢复面板', restore);
        }

        function clearFlash() {
            if (flashTimer) {
                clearTimeout(flashTimer);
                flashTimer = null;
            }
            if (flash && flash.el && flash.el.style) {
                flash.el.style.outline = flash.outline;
                flash.el.style.outlineOffset = flash.outlineOffset;
            }
            flash = null;
        }

        function locateNode(node) {
            if (!node || !node.style) return;
            clearFlash();
            flash = { el: node, outline: node.style.outline, outlineOffset: node.style.outlineOffset };
            node.style.outline = '2px solid #cf222e';
            node.style.outlineOffset = '2px';
            if (node.scrollIntoView) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
            minimize('已定位到页面元素', '恢复面板', restore);
            flashTimer = setTimeout(clearFlash, 2200);
        }

        /* ---------------- 元素拾取 ---------------- */

        function startPicker() {
            if (!ui) return;
            if (state.picker) {
                cancelPicker();
                return;
            }
            state.picker = { hovered: null, prev: null };
            minimize('移动鼠标预览元素，点击拾取 XPath，Esc 取消', '取消拾取', cancelPicker);
            document.addEventListener('mousemove', onPickMove, true);
            document.addEventListener('click', onPickClick, true);
        }

        function onPickMove(e) {
            if (!state.picker) return;
            const target = e.target;
            if (!target || target.nodeType !== 1 || isInHost(target)) return;
            if (state.picker.hovered === target) return;
            unpaintPick();
            state.picker.hovered = target;
            state.picker.prev = { outline: target.style.outline, outlineOffset: target.style.outlineOffset };
            target.style.outline = '2px solid #2da44e';
            target.style.outlineOffset = '2px';
        }

        function onPickClick(e) {
            const target = e.target;
            if (!target || isInHost(target)) return; // 面板自身的按钮放行
            e.preventDefault();
            e.stopPropagation();
            const xpath = generateXPath(target);
            stopPicker();
            if (!xpath) {
                restore();
                setStatus('无法为该元素生成 XPath', 'error');
                return;
            }
            ui.xpathInput.value = xpath;
            restore();
            runExtract();
        }

        function unpaintPick() {
            const picker = state.picker;
            if (picker && picker.hovered && picker.prev) {
                picker.hovered.style.outline = picker.prev.outline;
                picker.hovered.style.outlineOffset = picker.prev.outlineOffset;
            }
            if (picker) {
                picker.hovered = null;
                picker.prev = null;
            }
        }

        function stopPicker() {
            if (!state.picker) return;
            unpaintPick();
            state.picker = null;
            document.removeEventListener('mousemove', onPickMove, true);
            document.removeEventListener('click', onPickClick, true);
        }

        function cancelPicker() {
            stopPicker();
            restore();
        }

        // 为元素生成尽量简短且唯一的 XPath：优先 id 锚点，否则按同名兄弟序号逐级拼接
        function generateXPath(node) {
            if (!node || node.nodeType !== 1) return '';
            const docEl = document.documentElement;
            if (node === docEl) return '/html';
            const segs = [];
            let cur = node;
            let guard = 0;
            while (cur && cur.nodeType === 1 && guard++ < 200) {
                if (cur.id && /^[A-Za-z][\w:-]*$/.test(cur.id)) {
                    const head = '//*[@id="' + cur.id + '"]';
                    return head + (segs.length ? '/' + segs.join('/') : '');
                }
                const tag = String(cur.tagName || '').toLowerCase();
                if (!tag) break;
                const parent = cur.parentElement
                    || (cur.parentNode && cur.parentNode.nodeType === 1 ? cur.parentNode : null);
                let seg = tag;
                if (parent && parent.children) {
                    let same = 0;
                    let index = 0;
                    for (let i = 0; i < parent.children.length; i++) {
                        const sib = parent.children[i];
                        if (sib.tagName === cur.tagName) {
                            same++;
                            if (sib === cur) index = same;
                        }
                    }
                    if (same > 1) seg += '[' + index + ']';
                }
                segs.unshift(seg);
                if (!parent) break;
                if (parent === docEl) {
                    segs.unshift('html');
                    break;
                }
                cur = parent;
            }
            return '/' + segs.join('/');
        }

        /* ---------------- 模态框 ---------------- */

        const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
button, input, select, textarea { font-family: inherit; }
.overlay {
    position: fixed; inset: 0; z-index: 2147483600;
    display: none; align-items: center; justify-content: center; padding: 16px;
    background: rgba(15,23,42,.45);
    font: 13px/1.5 system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    color: #24292f;
}
.overlay.show { display: flex; }
.modal {
    width: min(780px, 92vw); max-height: 86vh; background: #fff;
    border-radius: 10px; box-shadow: 0 18px 48px rgba(0,0,0,.28);
    display: flex; flex-direction: column; overflow: hidden;
}
.header {
    display: flex; align-items: center; gap: 8px; padding: 12px 14px;
    border-bottom: 1px solid #eaeef2; background: #f6f8fa;
}
.title { font-weight: 600; font-size: 14px; }
.badge {
    font-size: 11px; color: #57606a; background: #eaeef2; border-radius: 10px;
    padding: 1px 8px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.header-spacer { flex: 1; }
.hint { font-size: 11px; color: #8c959f; }
.icon-btn {
    border: none; background: transparent; font-size: 18px; line-height: 1;
    color: #57606a; cursor: pointer; padding: 2px 6px; border-radius: 4px;
}
.icon-btn:hover { background: #eaeef2; color: #24292f; }
.config {
    padding: 12px 14px 10px; display: flex; flex-direction: column; gap: 8px;
    border-bottom: 1px solid #eaeef2;
}
.query-row { display: flex; gap: 6px; }
input[type=text], select, textarea {
    font-size: 12px; color: #24292f; background: #fff;
    border: 1px solid #d0d7de; border-radius: 6px; padding: 6px 8px;
}
input[type=text]:focus, select:focus, textarea:focus {
    outline: 2px solid rgba(74,144,226,.45); outline-offset: -1px; border-color: #4a90e2;
}
.xpath-input {
    flex: 1; min-width: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.xpath-input.invalid { border-color: #cf222e; }
.history { flex: 0 0 108px; width: 108px; max-width: 120px; min-width: 0; }
.btn {
    border: 1px solid #d0d7de; background: #f6f8fa; color: #24292f;
    border-radius: 6px; padding: 6px 10px; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.btn:hover { background: #eaeef2; }
.btn-primary { background: #2da44e; border-color: #2da44e; color: #fff; font-weight: 600; }
.btn.active { background: #ddf4ff; border-color: #54aeff; color: #0969da; font-weight: 600; }
.btn-primary:hover { background: #2c974b; }
.btn-small { padding: 4px 9px; font-size: 11px; }
.attr-row { display: flex; gap: 8px; align-items: center; }
.attr-row label { flex: 0 0 auto; font-size: 12px; color: #57606a; }
.attr-input { flex: 1; min-width: 0; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip {
    font-size: 11px; padding: 2px 7px; border-radius: 10px;
    border: 1px solid #d0d7de; background: #fff; color: #57606a; cursor: pointer;
}
.chip:hover { background: #f6f8fa; }
.chip.active { background: #ddf4ff; border-color: #54aeff; color: #0969da; font-weight: 600; }
.options-row {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px;
    font-size: 12px; color: #57606a;
}
.options-row label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
.options-row input[type=checkbox] { accent-color: #4a90e2; margin: 0; }
.filter-input { width: 140px; padding: 4px 7px; }
.grow { flex: 1; }
.formats { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.format-btn {
    font-size: 11px; padding: 3px 8px; border-radius: 12px;
    border: 1px solid #d0d7de; background: #fff; color: #57606a; cursor: pointer;
}
.format-btn:hover { background: #f6f8fa; }
.format-btn.active { background: #0969da; border-color: #0969da; color: #fff; }
.results { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.toolbar {
    display: flex; align-items: center; gap: 8px; padding: 8px 14px;
    border-bottom: 1px solid #eaeef2; flex-wrap: wrap;
}
.status { font-size: 12px; color: #57606a; flex: 1; min-width: 140px; }
.status.error { color: #cf222e; }
.status.ok { color: #1a7f37; }
.view-toggle, .tools { display: flex; gap: 4px; }
.view-btn {
    font-size: 11px; padding: 3px 9px; border-radius: 6px;
    border: 1px solid #d0d7de; background: #fff; color: #57606a; cursor: pointer;
}
.view-btn.active { background: #eaeef2; color: #24292f; font-weight: 600; }
.views { flex: 1; min-height: 0; display: flex; }
.view { flex: 1; min-height: 0; display: none; flex-direction: column; }
.view.active { display: flex; }
.result-text {
    flex: 1; width: 100%; min-height: 160px; border: none; border-radius: 0; resize: none;
    padding: 10px 14px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px; line-height: 1.55;
}
.list-wrap { flex: 1; overflow: auto; padding: 2px 10px 10px; }
.list-head, .row { display: flex; gap: 6px; align-items: center; }
.list-head {
    position: sticky; top: 0; background: #fff; z-index: 1;
    font-size: 11px; color: #8c959f; padding: 5px 2px; border-bottom: 1px solid #eaeef2;
}
.row { padding: 5px 2px; border-bottom: 1px solid #f3f5f7; font-size: 12px; }
.row:hover { background: #f6f8fa; }
.idx { flex: 0 0 34px; color: #8c959f; text-align: right; font-variant-numeric: tabular-nums; }
.cell {
    flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.cell a { color: #0969da; text-decoration: none; }
.cell a:hover { text-decoration: underline; }
.row-btn {
    flex: 0 0 auto; font-size: 11px; padding: 1px 6px; border-radius: 4px;
    border: 1px solid #d0d7de; background: #fff; color: #57606a; cursor: pointer;
}
.row-btn:hover { background: #eaeef2; }
.row-btn.ghost { visibility: hidden; pointer-events: none; }
.empty { padding: 24px; text-align: center; color: #8c959f; font-size: 12px; }
.mini {
    position: fixed; top: 14px; right: 14px; z-index: 2147483600;
    display: none; align-items: center; gap: 8px;
    background: rgba(36,41,47,.94); color: #fff; padding: 8px 12px; border-radius: 8px;
    font: 12px/1.4 system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    box-shadow: 0 6px 18px rgba(0,0,0,.3); max-width: min(560px, 92vw);
}
.mini.show { display: inline-flex; }
.mini-msg { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mini button {
    border: 1px solid rgba(255,255,255,.35); background: transparent; color: #fff;
    border-radius: 6px; padding: 3px 9px; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.mini button:hover { background: rgba(255,255,255,.14); }
`;

        function ensureMounted() {
            if (hostEl && hostEl.isConnected) return;
            hostEl = el('div', { id: CFG.rootId });
            shadow = hostEl.attachShadow({ mode: 'open' });
            shadow.appendChild(el('style', { text: CSS }));

            const closeBtn = el('button', { class: 'icon-btn', type: 'button', text: '×', title: '关闭（Esc）' });
            const badge = el('span', { class: 'badge' });
            const header = el('div', { class: 'header' },
                el('span', { class: 'title', text: 'XPath DOM 属性提取器' }),
                badge,
                el('span', { class: 'header-spacer' }),
                el('span', { class: 'hint', text: 'Esc 关闭' }),
                closeBtn);

            const xpathInput = el('input', {
                type: 'text', class: 'xpath-input', spellcheck: 'false',
                placeholder: '如 //a/@href 或 //div[@class="item"]，回车提取',
            });
            const historySel = el('select', { class: 'history', title: '最近使用的 XPath' });
            const pickBtn = el('button', { class: 'btn', type: 'button', text: '拾取元素', title: '在页面上点击元素，自动生成 XPath' });
            const extractBtn = el('button', { class: 'btn btn-primary', type: 'button', text: '提取' });
            const queryRow = el('div', { class: 'query-row' }, xpathInput, historySel, pickBtn, extractBtn);

            const attrInput = el('input', {
                type: 'text', class: 'attr-input', spellcheck: 'false',
                placeholder: '如 textContent、href、src、data-id，或多属性 textContent, href',
            });
            const attrRow = el('div', { class: 'attr-row' }, el('label', { text: '属性' }), attrInput);
            const chips = el('div', { class: 'chips' });
            const chipEls = {};
            for (const name of CFG.quickAttrs) {
                const chip = el('button', {
                    class: 'chip', type: 'button', 'data-attr': name, text: name,
                    title: '点击设为单属性，Shift+点击追加/移除（多属性）',
                });
                chipEls[name] = chip;
                chips.append(chip);
                chip.addEventListener('click', (e) => {
                    const list = parseAttrList(attrInput.value);
                    let next;
                    if (e.shiftKey) {
                        next = list.indexOf(name) >= 0 ? list.filter((x) => x !== name) : list.concat(name);
                    } else {
                        next = [name];
                    }
                    if (!next.length) next = ['textContent'];
                    attrInput.value = next.join(', ');
                    prefs.attr = attrInput.value;
                    savePrefs();
                    updateChipState();
                    if (ui.xpathInput.value.trim()) runExtract();
                });
            }

            const cbTrim = el('input', { type: 'checkbox' });
            const cbSkip = el('input', { type: 'checkbox' });
            const cbDedupe = el('input', { type: 'checkbox' });
            const cbResolve = el('input', { type: 'checkbox' });
            const mkLabel = (cb, label, title) => {
                const lb = el('label', { title: title || '' }, cb);
                lb.append(document.createTextNode(' ' + label));
                return lb;
            };
            const filterInput = el('input', { type: 'text', class: 'filter-input', placeholder: '结果过滤关键词' });
            const formats = el('div', { class: 'formats' });
            const formatBtns = {};
            for (const f of CFG.formats) {
                const b = el('button', { class: 'format-btn', type: 'button', 'data-format': f.key, text: f.label });
                formatBtns[f.key] = b;
                formats.append(b);
                b.addEventListener('click', () => {
                    setFormatUI(f.key);
                    savePrefs();
                    reFormat();
                });
            }
            const optionsRow = el('div', { class: 'options-row' },
                mkLabel(cbTrim, '去首尾空格'),
                mkLabel(cbSkip, '跳过空值'),
                mkLabel(cbDedupe, '去重'),
                mkLabel(cbResolve, '补全绝对URL(href/src)'),
                filterInput,
                el('span', { class: 'grow' }),
                formats);

            const config = el('div', { class: 'config' }, queryRow, attrRow, chips, optionsRow);

            const statusEl = el('div', { class: 'status' });
            const viewTextBtn = el('button', { class: 'view-btn active', type: 'button', text: '文本预览' });
            const viewListBtn = el('button', { class: 'view-btn', type: 'button', text: '列表视图' });
            const highlightBtn = el('button', { class: 'btn btn-small', type: 'button', text: '页面高亮', title: '高亮当前结果对应元素' });
            const consoleBtn = el('button', { class: 'btn btn-small', type: 'button', text: 'Console', title: '打印结果到浏览器控制台' });
            const exportBtn = el('button', { class: 'btn btn-small', type: 'button', text: '导出', title: '导出为文件' });
            const copyBtn = el('button', { class: 'btn btn-primary btn-small', type: 'button', text: '一键复制' });
            const toolbar = el('div', { class: 'toolbar' },
                statusEl,
                el('div', { class: 'view-toggle' }, viewTextBtn, viewListBtn),
                el('div', { class: 'tools' }, highlightBtn, consoleBtn, exportBtn, copyBtn));

            const textarea = el('textarea', {
                class: 'result-text', readonly: '', spellcheck: 'false',
                placeholder: '输入 XPath 后点击「提取」，结果将实时显示在这里…',
            });
            const textView = el('div', { class: 'view active' }, textarea);
            const listHead = el('div', { class: 'list-head' });
            const listBody = el('div', { class: 'list-body' });
            const listView = el('div', { class: 'view' },
                el('div', { class: 'list-wrap' }, listHead, listBody));
            const views = el('div', { class: 'views' }, textView, listView);
            const resultsSec = el('div', { class: 'results' }, toolbar, views);

            const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, header, config, resultsSec);
            const overlay = el('div', { class: 'overlay' }, modal);

            const miniMsg = el('span', { class: 'mini-msg' });
            const miniAction = el('button', { type: 'button', text: '恢复面板' });
            const mini = el('div', { class: 'mini' }, miniMsg, miniAction);

            shadow.append(overlay, mini);
            document.body.appendChild(hostEl);

            ui = {
                overlay, mini, miniMsg, miniAction, closeBtn, badge,
                xpathInput, historySel, pickBtn, extractBtn,
                attrInput, chips, chipEls, cbTrim, cbSkip, cbDedupe, cbResolve,
                filterInput, formats, formatBtns,
                statusEl, viewTextBtn, viewListBtn, highlightBtn, consoleBtn, exportBtn, copyBtn,
                textarea, textView, listView, listHead, listBody,
            };

            closeBtn.addEventListener('click', close);
            overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
            extractBtn.addEventListener('click', runExtract);
            pickBtn.addEventListener('click', startPicker);
            xpathInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    runExtract();
                }
            });
            xpathInput.addEventListener('change', () => {
                prefs.xpath = xpathInput.value.trim();
                savePrefs();
            });
            historySel.addEventListener('change', () => {
                const v = prefs.history[Number(historySel.value)];
                historySel.value = '';
                if (v) {
                    ui.xpathInput.value = v;
                    prefs.xpath = v;
                    savePrefs();
                    runExtract();
                }
            });
            attrInput.addEventListener('input', updateChipState);
            attrInput.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                skipAttrChange = true; // Enter 后浏览器可能紧接触发 change，避免重复提取
                applyAttrChange();
                setTimeout(() => { skipAttrChange = false; }, 0);
            });
            attrInput.addEventListener('change', () => {
                if (skipAttrChange) return;
                applyAttrChange();
            });
            for (const cb of [cbTrim, cbSkip, cbDedupe, cbResolve]) cb.addEventListener('change', onOptionsChange);
            filterInput.addEventListener('input', reFormat);
            viewTextBtn.addEventListener('click', () => { setViewUI('text'); savePrefs(); });
            viewListBtn.addEventListener('click', () => { setViewUI('list'); savePrefs(); });
            highlightBtn.addEventListener('click', toggleHighlight);
            consoleBtn.addEventListener('click', printConsole);
            exportBtn.addEventListener('click', exportFile);
            copyBtn.addEventListener('click', () => copyWithFeedback(copyBtn, currentText()));

            applyPrefsToUI();
        }

        function teardown() {
            if (hostEl && hostEl.parentNode) hostEl.parentNode.removeChild(hostEl);
            hostEl = null;
            shadow = null;
            ui = null;
            state.extraction = null;
            state.formatted = null;
        }

        function open() {
            if (opened) {
                if (state.minimized) restore();
                else close();
                return;
            }
            if (!prefsLoaded) loadPrefs();
            ensureMounted();
            if (!ui) return;
            opened = true;
            state.minimized = false;
            ui.overlay.classList.add('show');
            ui.mini.classList.remove('show');
            document.addEventListener('keydown', onDocKeyDown, true);
            applyPrefsToUI();
            if (prefs.xpath) runExtract();
            else ui.xpathInput.focus();
        }

        function close() {
            if (!opened && !hostEl) return;
            stopPicker();
            // LIFO：先还原定位闪烁，再清高亮，避免闪烁记录的颜色（可能是高亮蓝）被写回造成残留
            clearFlash();
            clearHighlight();
            document.removeEventListener('keydown', onDocKeyDown, true);
            opened = false;
            state.minimized = false;
            teardown();
        }

        function minimize(msg, actionLabel, actionFn) {
            if (!ui) return;
            state.minimized = true;
            ui.overlay.classList.remove('show');
            ui.mini.classList.add('show');
            ui.miniMsg.textContent = msg;
            ui.miniAction.textContent = actionLabel || '恢复面板';
            ui.miniAction.onclick = (e) => {
                e.stopPropagation();
                if (actionFn) actionFn();
                else restore();
            };
        }

        function restore() {
            if (!ui) return;
            state.minimized = false;
            ui.overlay.classList.add('show');
            ui.mini.classList.remove('show');
        }

        function onDocKeyDown(e) {
            if (e.key !== 'Escape') return;
            if (state.picker) {
                e.preventDefault();
                e.stopPropagation();
                cancelPicker();
                return;
            }
            if (state.minimized) {
                e.preventDefault();
                e.stopPropagation();
                restore();
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            close();
        }

        function isEditable(node) {
            if (!node || node.nodeType !== 1) return false;
            const tag = String(node.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
            if (node.isContentEditable) return true;
            try {
                return !!(node.closest && node.closest('[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]'));
            } catch (e) {
                return false;
            }
        }

        // 全站点快捷键：Alt+Shift+X 打开/关闭（输入框内不拦截，本面板内允许关闭）
        function onGlobalKeyDown(e) {
            if (!e.altKey || !e.shiftKey) return;
            if (String(e.key || '').toLowerCase() !== 'x') return;
            if (!isInHost(e.target) && isEditable(e.target)) return;
            e.preventDefault();
            open();
        }

        function registerEntry() {
            // typeof 保护：Node 单测沙箱无 GM_registerMenuCommand 时不抛异常
            if (typeof GM_registerMenuCommand === 'function') {
                try {
                    GM_registerMenuCommand('XPath 属性提取器', () => open());
                } catch (e) {
                    log('注册油猴菜单失败:', e);
                }
            }
            window.addEventListener('keydown', onGlobalKeyDown, true);
        }

        return {
            open,
            close,
            registerEntry,
            // 引擎（供 Node 自动化单测与后续复用）
            extractByXPath,
            formatResults,
            extractNodeAttr,
            evaluateXPath,
            generateXPath,
        };
    })();

    /* ================================
     * 启动：全站点按需唤起（仅注册菜单/快捷键，默认零 DOM 注入）
     * ================================ */
    if (window.top !== window.self) return; // 仅在顶层窗口运行，避免 iframe 内重复挂载

    xpathExtractor.registerEntry();

    // 受控测试钩子：仅当 Node 单测沙箱显式设置 globalThis.__XPATH_EXTRACTOR_TEST__ 时暴露；
    // 真实浏览器中该全局不存在，不会污染宿主页面。
    if (typeof globalThis !== 'undefined' && globalThis.__XPATH_EXTRACTOR_TEST__) {
        try {
            Object.defineProperty(globalThis, '__xpathExtractorTestHooks', {
                value: {
                    CONFIG,
                    storage,
                    xpathExtractor,
                    extractByXPath: xpathExtractor.extractByXPath,
                    formatResults: xpathExtractor.formatResults,
                    extractNodeAttr: xpathExtractor.extractNodeAttr,
                    evaluateXPath: xpathExtractor.evaluateXPath,
                    generateXPath: xpathExtractor.generateXPath,
                },
                configurable: true,
                writable: true,
                enumerable: false,
            });
        } catch (e) { /* noop */ }
    }
})();
