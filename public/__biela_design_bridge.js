/**
 * Design Tools Bridge v2
 *
 * Injected into the preview iframe to enable design tools.
 * Communicates with parent via postMessage.
 *
 * Protocol: all messages have { type: 'biela:dt:*', ... } shape.
 *
 * Parent → iframe:
 *   biela:dt:activate          — start listening for hover/click
 *   biela:dt:deactivate        — stop listening, clean up overlays
 *   biela:dt:apply-style       — { selector, property, value }
 *   biela:dt:undo-style        — { selector, property, value } (restore previous)
 *   biela:dt:get-styles        — { selector } → reply with computed styles
 *   biela:dt:scroll-to         — { selector }
 *   biela:dt:set-grid          — { visible, columns, gap, maxWidth }
 *   biela:dt:measure-mode      — { enabled, mode }
 *   biela:dt:get-element-info  — { selector } → reply with full info
 *   biela:dt:highlight         — { selector } → briefly highlight element
 *
 * iframe → Parent:
 *   biela:dt:ready             — bridge loaded
 *   biela:dt:element-hover     — { info }
 *   biela:dt:element-select    — { info }
 *   biela:dt:element-deselect  — (cleared)
 *   biela:dt:styles-response   — { selector, styles }
 *   biela:dt:element-info      — { info }
 *   biela:dt:measurement       — { data }
 */

(function () {
  'use strict';

  if (window.__bielaDTBridge) return; // already loaded
  window.__bielaDTBridge = true;

  const EDITOR_ATTR = 'data-biela-dt';
  const HIGHLIGHT_CLASS = 'biela-dt-highlight';
  const HOVER_CLASS = 'biela-dt-hover';
  const SELECTED_CLASS = 'biela-dt-selected';

  let active = false;
  let selectedElement = null;
  let hoveredElement = null;
  let styleSheet = null;
  let gridOverlay = null;
  let selectionBox = null;
  let injectedStyles = {}; // { selector: { property: value } }

  // Drag state
  let isDragging = false;
  let dragStartX = 0, dragStartY = 0;
  let dragElStartX = 0, dragElStartY = 0;

  // Resize state
  let isResizing = false;
  let resizeHandle = '';
  let resizeStartX = 0, resizeStartY = 0;
  let resizeStartW = 0, resizeStartH = 0;
  let resizeStartLeft = 0, resizeStartTop = 0;

  // Text editing state
  let isEditing = false;
  let editingElement = null;

  // ── Utilities ─────────────────────────────────────────────

  function isEditorElement(el) {
    if (!el || !el.closest) return true;
    return !!el.closest(`[${EDITOR_ATTR}]`);
  }

  function generateSelector(el) {
    if (!el || el === document.body || el === document.documentElement) {
      return el === document.body ? 'body' : 'html';
    }

    // Prefer id
    if (el.id && !/biela/i.test(el.id)) {
      return '#' + CSS.escape(el.id);
    }

    // data attribute
    for (const attr of el.attributes) {
      if (attr.name.startsWith('data-') && !/biela/i.test(attr.name)) {
        return `[${attr.name}="${CSS.escape(attr.value)}"]`;
      }
    }

    // tag + class
    const tag = el.tagName.toLowerCase();
    const classes = Array.from(el.classList)
      .filter((c) => !/biela|moveable|selecto/i.test(c))
      .slice(0, 3);
    if (classes.length > 0) {
      const sel = tag + '.' + classes.map(CSS.escape).join('.');
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    // Nth-of-type path
    const parts = [];
    let node = el;
    while (node && node !== document.body) {
      const t = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === node.tagName
        );
        if (siblings.length > 1) {
          const idx = siblings.indexOf(node) + 1;
          parts.unshift(`${t}:nth-of-type(${idx})`);
        } else {
          parts.unshift(t);
        }
      } else {
        parts.unshift(t);
      }
      node = parent;
    }
    return parts.join(' > ');
  }

  function getElementInfo(el) {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);

    // Try to determine page number
    let pageNumber = 1;
    const slide = el.closest('[data-page], .slide, .page, section');
    if (slide) {
      const siblings = Array.from(
        slide.parentElement?.children ?? []
      ).filter((c) => c.matches('[data-page], .slide, .page, section'));
      pageNumber = siblings.indexOf(slide) + 1;
    }

    const tag = el.tagName.toLowerCase();
    return {
      selector: generateSelector(el),
      tagName: tag,
      id: el.id || '',
      className: el.className || '',
      textContent: (el.textContent || '').trim().slice(0, 200),
      src: el.getAttribute('src') || undefined,
      dataAiId: el.getAttribute('data-ai-id') || undefined,
      rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
      computedStyles: {
        display: cs.display,
        position: cs.position,
        background: cs.background,
        backgroundColor: cs.backgroundColor,
        color: cs.color,
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
        textAlign: cs.textAlign,
        padding: cs.padding,
        margin: cs.margin,
        border: cs.border,
        borderRadius: cs.borderRadius,
        boxShadow: cs.boxShadow,
        opacity: cs.opacity,
        overflow: cs.overflow,
        width: cs.width,
        height: cs.height,
        maxWidth: cs.maxWidth,
        gap: cs.gap,
        flexDirection: cs.flexDirection,
        justifyContent: cs.justifyContent,
        alignItems: cs.alignItems,
        gridTemplateColumns: cs.gridTemplateColumns,
      },
      pageNumber,
    };
  }

  // ── Style injection ───────────────────────────────────────

  function getOrCreateStyleSheet() {
    if (styleSheet) return styleSheet;
    const style = document.createElement('style');
    style.id = 'biela-dt-styles';
    style.setAttribute(EDITOR_ATTR, '');
    document.head.appendChild(style);
    styleSheet = style;
    return style;
  }

  function rebuildStyleSheet() {
    const style = getOrCreateStyleSheet();
    const rules = [];
    for (const [selector, props] of Object.entries(injectedStyles)) {
      const decls = Object.entries(props)
        .map(([p, v]) => `${p}: ${v} !important`)
        .join('; ');
      if (decls) rules.push(`${selector} { ${decls}; }`);
    }
    style.textContent = rules.join('\n');
  }

  function applyStyle(selector, property, value) {
    if (!injectedStyles[selector]) injectedStyles[selector] = {};
    injectedStyles[selector][property] = value;
    rebuildStyleSheet();
  }

  function removeStyle(selector, property) {
    if (injectedStyles[selector]) {
      delete injectedStyles[selector][property];
      if (Object.keys(injectedStyles[selector]).length === 0) {
        delete injectedStyles[selector];
      }
      rebuildStyleSheet();
    }
  }

  // ── Visual overlays ───────────────────────────────────────

  function injectOverlayCSS() {
    const existing = document.getElementById('biela-dt-overlay-css');
    if (existing) return;
    const s = document.createElement('style');
    s.id = 'biela-dt-overlay-css';
    s.setAttribute(EDITOR_ATTR, '');
    s.textContent = `
      .${HOVER_CLASS} {
        outline: 2px dashed rgba(0, 191, 255, 0.6) !important;
        outline-offset: 1px !important;
      }
      .${SELECTED_CLASS} {
        outline: 2px solid rgba(0, 191, 255, 1) !important;
        outline-offset: 1px !important;
      }
      .${HIGHLIGHT_CLASS} {
        outline: 3px solid rgba(255, 200, 0, 0.8) !important;
        outline-offset: 2px !important;
        transition: outline 0.3s ease !important;
      }
      .biela-dt-selection-box {
        position: fixed; pointer-events: none; z-index: 999999;
        border: 1px solid rgba(0, 150, 255, 0.9);
        background: rgba(0, 150, 255, 0.04);
      }
      .biela-dt-handle {
        position: absolute; width: 8px; height: 8px;
        background: #fff; border: 1.5px solid rgba(0, 150, 255, 0.9);
        border-radius: 1px; pointer-events: all;
      }
      .biela-dt-handle-nw { top:-4px; left:-4px; cursor:nwse-resize; }
      .biela-dt-handle-n  { top:-4px; left:calc(50% - 4px); cursor:ns-resize; }
      .biela-dt-handle-ne { top:-4px; right:-4px; cursor:nesw-resize; }
      .biela-dt-handle-e  { top:calc(50% - 4px); right:-4px; cursor:ew-resize; }
      .biela-dt-handle-se { bottom:-4px; right:-4px; cursor:nwse-resize; }
      .biela-dt-handle-s  { bottom:-4px; left:calc(50% - 4px); cursor:ns-resize; }
      .biela-dt-handle-sw { bottom:-4px; left:-4px; cursor:nesw-resize; }
      .biela-dt-handle-w  { top:calc(50% - 4px); left:-4px; cursor:ew-resize; }
      .biela-dt-size-label {
        position: absolute; bottom: -22px; left: 50%;
        transform: translateX(-50%); font: 10px/1 monospace;
        color: #fff; background: rgba(0, 150, 255, 0.85);
        padding: 2px 5px; border-radius: 3px; white-space: nowrap;
        pointer-events: none;
      }
      .biela-dt-editing {
        outline: 2px solid rgba(0, 191, 255, 1) !important;
        cursor: text !important;
        min-width: 20px; min-height: 1em;
      }
    `;
    document.head.appendChild(s);
  }

  function clearHover() {
    if (hoveredElement) {
      hoveredElement.classList.remove(HOVER_CLASS);
      hoveredElement = null;
    }
  }

  function clearSelected() {
    if (selectedElement) {
      selectedElement.classList.remove(SELECTED_CLASS);
      selectedElement = null;
    }
    removeSelectionBox();
  }

  // ── Selection box with resize handles ─────────────────────

  function updateSelectionBox() {
    if (!selectedElement) { removeSelectionBox(); return; }
    var rect = selectedElement.getBoundingClientRect();
    if (!selectionBox) {
      selectionBox = document.createElement('div');
      selectionBox.className = 'biela-dt-selection-box';
      selectionBox.setAttribute(EDITOR_ATTR, '');
      var handles = ['nw','n','ne','e','se','s','sw','w'];
      handles.forEach(function(h) {
        var d = document.createElement('div');
        d.className = 'biela-dt-handle biela-dt-handle-' + h;
        d.setAttribute(EDITOR_ATTR, '');
        d.dataset.handle = h;
        d.addEventListener('mousedown', onResizeStart, true);
        selectionBox.appendChild(d);
      });
      var label = document.createElement('div');
      label.className = 'biela-dt-size-label';
      label.setAttribute(EDITOR_ATTR, '');
      selectionBox.appendChild(label);
      document.body.appendChild(selectionBox);
    }
    selectionBox.style.left = rect.left + 'px';
    selectionBox.style.top = rect.top + 'px';
    selectionBox.style.width = rect.width + 'px';
    selectionBox.style.height = rect.height + 'px';
    var label = selectionBox.querySelector('.biela-dt-size-label');
    if (label) label.textContent = Math.round(rect.width) + ' × ' + Math.round(rect.height);
  }

  function removeSelectionBox() {
    if (selectionBox) { selectionBox.remove(); selectionBox = null; }
  }

  // ── Text editing ────────────────────────────────────────────

  var TEXT_TAGS = new Set(['p','h1','h2','h3','h4','h5','h6','span','a','li','td','th','label','button','figcaption','blockquote','em','strong','b','i','small']);

  function startTextEdit(el) {
    if (isEditing) stopTextEdit();
    isEditing = true;
    editingElement = el;
    el.contentEditable = 'true';
    el.classList.add('biela-dt-editing');
    el.focus();
    // Select all text
    var range = document.createRange();
    range.selectNodeContents(el);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function stopTextEdit() {
    if (!isEditing || !editingElement) return;
    editingElement.contentEditable = 'false';
    editingElement.classList.remove('biela-dt-editing');
    // Notify parent of text change
    send('biela:dt:text-changed', {
      selector: generateSelector(editingElement),
      text: editingElement.textContent,
    });
    isEditing = false;
    editingElement = null;
  }

  // ── Grid overlay ──────────────────────────────────────────

  function showGrid(columns, gap, maxWidth) {
    removeGrid();
    gridOverlay = document.createElement('div');
    gridOverlay.setAttribute(EDITOR_ATTR, '');
    gridOverlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      pointer-events: none; z-index: 999998;
      display: flex; justify-content: center;
    `;
    const inner = document.createElement('div');
    inner.style.cssText = `
      width: 100%; max-width: ${maxWidth};
      display: grid; grid-template-columns: repeat(${columns}, 1fr);
      gap: ${gap}px; height: 100%;
    `;
    for (let i = 0; i < columns; i++) {
      const col = document.createElement('div');
      col.style.cssText = `background: rgba(0, 191, 255, 0.06); border: 1px solid rgba(0, 191, 255, 0.12);`;
      inner.appendChild(col);
    }
    gridOverlay.appendChild(inner);
    document.body.appendChild(gridOverlay);
  }

  function removeGrid() {
    if (gridOverlay) {
      gridOverlay.remove();
      gridOverlay = null;
    }
  }

  // ── Event handlers ────────────────────────────────────────

  function onMouseMove(e) {
    if (!active) return;

    // Drag in progress — move element
    if (isDragging && selectedElement) {
      e.preventDefault();
      var dx = e.clientX - dragStartX;
      var dy = e.clientY - dragStartY;
      var sel = generateSelector(selectedElement);
      applyStyle(sel, 'position', 'relative');
      applyStyle(sel, 'left', (dragElStartX + dx) + 'px');
      applyStyle(sel, 'top', (dragElStartY + dy) + 'px');
      updateSelectionBox();
      return;
    }

    // Resize in progress
    if (isResizing && selectedElement) {
      e.preventDefault();
      onResizeMove(e);
      return;
    }

    // Normal hover
    if (isEditing) return; // don't change hover while editing text
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isEditorElement(el) || el === hoveredElement) return;

    clearHover();
    hoveredElement = el;
    el.classList.add(HOVER_CLASS);

    send('biela:dt:element-hover', { info: getElementInfo(el) });
  }

  function onMouseDown(e) {
    if (!active || isEditing) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isEditorElement(el)) return;

    // If clicking on the already-selected element, start drag
    if (el === selectedElement) {
      e.preventDefault();
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      var cs = getComputedStyle(selectedElement);
      dragElStartX = parseInt(cs.left, 10) || 0;
      dragElStartY = parseInt(cs.top, 10) || 0;
      document.body.style.cursor = 'grabbing';
      return;
    }
  }

  function onMouseUp(e) {
    if (isDragging && selectedElement) {
      isDragging = false;
      document.body.style.cursor = '';
      send('biela:dt:element-moved', { info: getElementInfo(selectedElement) });
      updateSelectionBox();
    }
    if (isResizing) {
      onResizeEnd();
    }
  }

  function onClick(e) {
    if (!active) return;
    if (isDragging || isResizing) return; // ignore click at end of drag

    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isEditorElement(el)) return;

    e.preventDefault();
    e.stopPropagation();

    // If clicking same element while editing, let the cursor work
    if (isEditing && el === editingElement) return;

    stopTextEdit();
    clearSelected();
    selectedElement = el;
    el.classList.add(SELECTED_CLASS);
    updateSelectionBox();

    send('biela:dt:element-select', { info: getElementInfo(el) });
  }

  function onDblClick(e) {
    if (!active) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isEditorElement(el)) return;

    e.preventDefault();
    e.stopPropagation();

    var tag = el.tagName.toLowerCase();
    if (TEXT_TAGS.has(tag) || (el.children.length === 0 && el.textContent.trim().length > 0)) {
      startTextEdit(el);
      removeSelectionBox(); // hide box during editing
    }
  }

  function onKeyDown(e) {
    if (!active) return;

    // While editing text, only intercept Escape
    if (isEditing) {
      if (e.key === 'Escape') {
        stopTextEdit();
        updateSelectionBox();
      }
      return; // let all other keys through for text editing
    }

    if (e.key === 'Escape') {
      clearSelected();
      removeSelectionBox();
      send('biela:dt:element-deselect', {});
      return;
    }

    // Arrow keys — nudge selected element
    if (selectedElement && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].indexOf(e.key) !== -1) {
      e.preventDefault();
      var step = e.shiftKey ? 10 : 1;
      var sel = generateSelector(selectedElement);
      var cs = getComputedStyle(selectedElement);
      var curLeft = parseInt(cs.left, 10) || 0;
      var curTop = parseInt(cs.top, 10) || 0;
      applyStyle(sel, 'position', 'relative');
      if (e.key === 'ArrowLeft')  applyStyle(sel, 'left', (curLeft - step) + 'px');
      if (e.key === 'ArrowRight') applyStyle(sel, 'left', (curLeft + step) + 'px');
      if (e.key === 'ArrowUp')    applyStyle(sel, 'top', (curTop - step) + 'px');
      if (e.key === 'ArrowDown')  applyStyle(sel, 'top', (curTop + step) + 'px');
      updateSelectionBox();
      send('biela:dt:element-moved', { info: getElementInfo(selectedElement) });
    }

    // Delete key — hide selected element
    if (selectedElement && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      var sel2 = generateSelector(selectedElement);
      applyStyle(sel2, 'display', 'none');
      clearSelected();
      removeSelectionBox();
      send('biela:dt:element-deselect', {});
    }
  }

  // ── Resize handlers ────────────────────────────────────────

  function onResizeStart(e) {
    if (!selectedElement) return;
    e.preventDefault();
    e.stopPropagation();
    isResizing = true;
    resizeHandle = e.target.dataset.handle;
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    var rect = selectedElement.getBoundingClientRect();
    resizeStartW = rect.width;
    resizeStartH = rect.height;
    var cs = getComputedStyle(selectedElement);
    resizeStartLeft = parseInt(cs.left, 10) || 0;
    resizeStartTop = parseInt(cs.top, 10) || 0;
  }

  function onResizeMove(e) {
    if (!isResizing || !selectedElement) return;
    var dx = e.clientX - resizeStartX;
    var dy = e.clientY - resizeStartY;
    var sel = generateSelector(selectedElement);
    var h = resizeHandle;
    var newW = resizeStartW, newH = resizeStartH;
    var newL = resizeStartLeft, newT = resizeStartTop;

    if (h.indexOf('e') !== -1) newW = Math.max(10, resizeStartW + dx);
    if (h.indexOf('w') !== -1) { newW = Math.max(10, resizeStartW - dx); newL = resizeStartLeft + dx; }
    if (h.indexOf('s') !== -1) newH = Math.max(10, resizeStartH + dy);
    if (h.indexOf('n') !== -1) { newH = Math.max(10, resizeStartH - dy); newT = resizeStartTop + dy; }

    applyStyle(sel, 'width', Math.round(newW) + 'px');
    applyStyle(sel, 'height', Math.round(newH) + 'px');
    if (h.indexOf('w') !== -1) { applyStyle(sel, 'position', 'relative'); applyStyle(sel, 'left', newL + 'px'); }
    if (h.indexOf('n') !== -1) { applyStyle(sel, 'position', 'relative'); applyStyle(sel, 'top', newT + 'px'); }
    updateSelectionBox();
  }

  function onResizeEnd() {
    isResizing = false;
    resizeHandle = '';
    if (selectedElement) {
      send('biela:dt:element-resized', { info: getElementInfo(selectedElement) });
    }
  }

  // ── Message handling ──────────────────────────────────────

  function send(type, data) {
    try {
      window.parent.postMessage({ type, ...data }, '*');
    } catch {
      /* cross-origin safety */
    }
  }

  function handleMessage(e) {
    if (!e.data || !e.data.type) return;
    const { type } = e.data;

    switch (type) {
      case 'biela:dt:activate':
        activate();
        break;

      case 'biela:dt:deactivate':
        deactivate();
        break;

      case 'biela:dt:apply-style': {
        const { selector, property, value } = e.data;
        applyStyle(selector, property, value);
        break;
      }

      case 'biela:dt:undo-style': {
        const { selector, property, value } = e.data;
        if (value) {
          applyStyle(selector, property, value);
        } else {
          removeStyle(selector, property);
        }
        break;
      }

      case 'biela:dt:get-styles': {
        const { selector } = e.data;
        const el = document.querySelector(selector);
        if (el) {
          send('biela:dt:styles-response', {
            selector,
            styles: getElementInfo(el).computedStyles,
          });
        }
        break;
      }

      case 'biela:dt:scroll-to': {
        const { selector } = e.data;
        const el = document.querySelector(selector);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        break;
      }

      case 'biela:dt:set-grid': {
        const { visible, columns, gap, maxWidth } = e.data;
        if (visible) {
          showGrid(columns || 12, gap || 16, maxWidth || '1200px');
        } else {
          removeGrid();
        }
        break;
      }

      case 'biela:dt:get-element-info': {
        const { selector } = e.data;
        const el = document.querySelector(selector);
        if (el) {
          send('biela:dt:element-info', { info: getElementInfo(el) });
        }
        break;
      }

      case 'biela:dt:highlight': {
        const { selector } = e.data;
        const el = document.querySelector(selector);
        if (el) {
          el.classList.add(HIGHLIGHT_CLASS);
          setTimeout(() => el.classList.remove(HIGHLIGHT_CLASS), 1500);
        }
        break;
      }

      case 'biela:dt:get-sections': {
        send('biela:dt:sections-response', { sections: buildSectionTree() });
        break;
      }

      case 'biela:dt:get-design-info': {
        send('biela:dt:design-info-response', { designInfo: extractDesignInfo() });
        break;
      }
    }
  }

  // ── Section tree builder ─────────────────────────────────

  const SECTION_TAGS = new Set([
    'header', 'main', 'section', 'footer', 'nav', 'article', 'aside',
    'div', 'form', 'ul', 'ol', 'table',
  ]);

  function buildSectionTree() {
    function walk(el, depth) {
      if (depth > 4) return null; // cap depth
      if (el.hasAttribute && el.hasAttribute(EDITOR_ATTR)) return null;
      var tag = el.tagName ? el.tagName.toLowerCase() : '';
      // At depth 0-1 include semantic + structural tags; deeper only semantic
      var isSemantic = ['header','main','section','footer','nav','article','aside'].indexOf(tag) !== -1;
      var isStructural = SECTION_TAGS.has(tag);
      if (depth > 2 && !isSemantic) return null;
      if (!isStructural && depth > 0) return null;

      var children = [];
      for (var i = 0; i < el.children.length; i++) {
        var child = walk(el.children[i], depth + 1);
        if (child) children.push(child);
      }
      return {
        tagName: tag,
        id: el.id || '',
        className: typeof el.className === 'string' ? el.className.split(' ').filter(Boolean).slice(0, 3).join(' ') : '',
        selector: generateSelector(el),
        children: children,
      };
    }
    var root = document.body;
    var result = [];
    for (var i = 0; i < root.children.length; i++) {
      var node = walk(root.children[i], 0);
      if (node) result.push(node);
    }
    return result;
  }

  // ── Design info extractor ──────────────────────────────────

  function extractDesignInfo() {
    var colors = new Set();
    var fonts = new Set();
    var fontSizes = {};
    var all = document.querySelectorAll('body *');

    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.hasAttribute && el.hasAttribute(EDITOR_ATTR)) continue;
      var cs = getComputedStyle(el);

      // Colors
      if (cs.color && cs.color !== 'rgba(0, 0, 0, 0)') colors.add(cs.color);
      if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') {
        colors.add(cs.backgroundColor);
      }

      // Fonts
      var ff = cs.fontFamily.split(',')[0].trim().replace(/['"]/g, '');
      if (ff) fonts.add(ff);

      // Typography scale (tag-based)
      var tag = el.tagName.toLowerCase();
      if (['h1','h2','h3','h4','h5','h6','p','span','a','li'].indexOf(tag) !== -1) {
        var key = tag.toUpperCase();
        if (tag === 'p' || tag === 'span' || tag === 'a' || tag === 'li') key = 'Body';
        if (!fontSizes[key]) {
          fontSizes[key] = {
            size: cs.fontSize,
            weight: cs.fontWeight,
            lineHeight: cs.lineHeight,
            family: ff,
          };
        }
      }
    }

    // Container width
    var container = document.querySelector('main') || document.querySelector('[class*="container"]') || document.body.children[0];
    var containerWidth = container ? getComputedStyle(container).maxWidth : 'none';

    return {
      colors: Array.from(colors).slice(0, 20),
      fonts: Array.from(fonts),
      typography: fontSizes,
      spacing: {
        containerWidth: containerWidth,
        bodyPadding: getComputedStyle(document.body).padding,
      },
    };
  }

  // ── Activate / deactivate ─────────────────────────────────

  function activate() {
    if (active) return;
    active = true;
    injectOverlayCSS();
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('dblclick', onDblClick, true);
    document.addEventListener('keydown', onKeyDown, true);
  }

  function deactivate() {
    active = false;
    stopTextEdit();
    clearHover();
    clearSelected();
    removeSelectionBox();
    removeGrid();
    isDragging = false;
    isResizing = false;
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('mouseup', onMouseUp, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('dblclick', onDblClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
  }

  // ── Init ──────────────────────────────────────────────────

  window.addEventListener('message', handleMessage);
  send('biela:dt:ready', {});
})();
