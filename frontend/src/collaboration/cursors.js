import * as Y from 'yjs';

const safeColor = value => /^#[0-9a-f]{6}$/i.test(value) || /^hsl\([\d.]+ 70% 70%\)$/.test(value);

// Keep awareness separate from y-monaco's text binding so every editor listener,
// widget and decoration can be disposed when tabs or permissions change.
export class CollaborativeCursors {
  constructor(provider, editor, monaco, onPresence = () => {}) {
    Object.assign(this, { provider, editor, monaco, onPresence });
    this.items = new Map(); this.decorations = []; this.presenceKey = '';
    this.renderSoon = () => {
      if (this.frame == null) this.frame = requestAnimationFrame(() => { this.frame = null; this.render(); });
    };
    this.dismissOtherLabels = event => {
      for (const item of this.items.values()) if (!item.node.contains(event.target)) item.dismiss();
    };
    document.addEventListener('pointerdown', this.dismissOtherLabels, true);
    this.selectionListener = editor.onDidChangeCursorSelection(() => this.publish());
    this.blurListener = editor.onDidBlurEditorText(() => this.publish());
    provider.awareness.on('change', this.renderSoon);
    provider.doc.on('afterTransaction', this.renderSoon);
    this.publish(); this.render();
  }
  publish() {
    const model = this.editor.getModel(), selection = this.editor.getSelection();
    if (!model || !selection) return;
    const position = point => Y.createRelativePositionFromTypeIndex(this.provider.text, model.getOffsetAt(point));
    this.provider.awareness.setLocalStateField('selection', {
      anchor: position({ lineNumber: selection.selectionStartLineNumber, column: selection.selectionStartColumn }),
      head: position({ lineNumber: selection.positionLineNumber, column: selection.positionColumn }),
    });
  }
  index(relative) {
    try {
      const result = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(relative), this.provider.doc);
      return result?.type === this.provider.text ? result.index : null;
    } catch { return null; }
  }
  create(id, user) {
    const node = document.createElement('button');
    node.type = 'button'; node.className = 'shared-caret'; node.style.setProperty('--collaborator-color', user.color);
    node.setAttribute('aria-label', `${user.username}'s cursor`);
    const label = document.createElement('span'); label.className = 'shared-caret-label'; label.textContent = user.username;
    label.hidden = true; node.append(label);
    let pinned = false;
    const show = () => { label.hidden = false; };
    const hide = () => { if (!pinned) label.hidden = true; };
    const dismiss = () => { pinned = false; label.hidden = true; };
    const tap = event => { event.stopPropagation(); pinned = true; show(); };
    node.addEventListener('mouseenter', show); node.addEventListener('mouseleave', hide);
    node.addEventListener('focus', show); node.addEventListener('blur', dismiss); node.addEventListener('click', tap);
    node.addEventListener('pointerup', event => { if (['touch', 'pen'].includes(event.pointerType)) tap(event); });
    node.addEventListener('keydown', event => { if (event.key === 'Escape') dismiss(); });
    const style = document.createElement('style');
    style.textContent = `.shared-selection-${id} { background-color: color-mix(in srgb, ${user.color} 25%, transparent); }`;
    document.head.append(style);
    const item = { node, label, style, dismiss, color: user.color, position: null,
      getId: () => `shared-caret-${id}`, getDomNode: () => node,
      getPosition: () => item.position && ({ position: item.position, preference: [this.monaco.editor.ContentWidgetPositionPreference.EXACT] }),
      allowEditorOverflow: false, suppressMouseDown: true };
    this.editor.addContentWidget(item); this.items.set(id, item); return item;
  }
  remove(id, item) {
    this.editor.removeContentWidget(item); item.style.remove(); item.node.remove(); this.items.delete(id);
  }
  render() {
    const model = this.editor.getModel(); if (!model) return;
    const active = new Set(), decorations = [], people = new Map(), hitTargets = new Map();
    for (const [id, state] of [...this.provider.awareness.getStates()].sort(([a], [b]) => a - b)) {
      const user = state?.user;
      if (!user || typeof user.username !== 'string' || !safeColor(user.color)) continue;
      people.set(user.id, user); // Several tabs share one header identity, but have independent carets.
      if (id === this.provider.doc.clientID || id === this.provider.presenceId || !state.selection) continue;
      const anchor = this.index(state.selection.anchor), head = this.index(state.selection.head);
      if (anchor == null || head == null) continue;
      let item = this.items.get(id);
      if (item && item.color !== user.color) { this.remove(id, item); item = null; }
      item ||= this.create(id, user); active.add(id);
      // Nearby carets need separate hit targets, especially on touch. Keep the
      // logical Monaco/Yjs position exact and fan out only the overlay hit area.
      item.position = model.getPositionAt(head);
      const point = this.editor.getScrolledVisiblePosition?.(item.position);
      const row = point?.top ?? item.position.lineNumber;
      const left = point?.left ?? item.position.column * 8;
      const width = window.matchMedia?.('(pointer:coarse)')?.matches ? 20 : 10;
      const targets = hitTargets.get(row) || [];
      let target = left;
      for (const occupied of targets.sort((a, b) => a - b)) {
        if (target < occupied + width && target + width > occupied) target = occupied + width;
      }
      targets.push(target); hitTargets.set(row, targets);
      item.node.style.setProperty('--caret-offset', `${target - left}px`);
      this.editor.layoutContentWidget(item);
      if (anchor !== head) {
        const start = model.getPositionAt(Math.min(anchor, head)), end = model.getPositionAt(Math.max(anchor, head));
        decorations.push({ range: new this.monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
          options: { className: `shared-selection-${id}`, stickiness: this.monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } });
      }
    }
    for (const [id, item] of this.items) if (!active.has(id)) this.remove(id, item);
    this.decorations = this.editor.deltaDecorations(this.decorations, decorations);
    const users = [...people.values()].sort((a, b) => a.id - b.id);
    const key = JSON.stringify(users);
    if (this.presenceKey !== key) { this.presenceKey = key; this.onPresence(users); }
  }
  destroy() {
    if (this.frame != null) cancelAnimationFrame(this.frame);
    document.removeEventListener('pointerdown', this.dismissOtherLabels, true);
    this.selectionListener.dispose(); this.blurListener.dispose();
    this.provider.awareness.off('change', this.renderSoon); this.provider.doc.off('afterTransaction', this.renderSoon);
    for (const [id, item] of this.items) this.remove(id, item);
    if (!this.editor.getModel()?.isDisposed()) this.editor.deltaDecorations(this.decorations, []);
    this.provider.awareness.setLocalStateField('selection', null); this.onPresence([]);
  }
}
