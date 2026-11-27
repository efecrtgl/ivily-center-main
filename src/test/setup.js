// jsdom lacks layout APIs that CodeMirror calls while measuring; provide inert versions.
if (typeof Range !== 'undefined') {
  Range.prototype.getClientRects ??= function getClientRects() {
    return { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] };
  };
  Range.prototype.getBoundingClientRect ??= function getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON() {} };
  };
}
if (typeof Element !== 'undefined') Element.prototype.scrollIntoView ??= function scrollIntoView() {};
