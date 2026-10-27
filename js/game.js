/**
 * 打字判定引擎：以输入框的完整值为准逐字比对，
 * 这样中文输入法的拼音组合过程不会被误判为错误。
 * 数字模式（skipSpaces）：目标中的空格仅用于分组展示，
 * 玩家只输入数字，引擎在比对时自动跳过空格位置。
 */
export class TypingEngine {
  constructor(target, options = {}) {
    this.target = target;
    this.skipSpaces = !!options.skipSpaces;
    // map[i] = 玩家输入的第 i 个字符在 target 中的位置（跳过空格）
    if (this.skipSpaces) {
      this.map = [];
      for (let i = 0; i < target.length; i += 1) {
        if (target.charAt(i) !== ' ') this.map.push(i);
      }
      this.cmpTarget = this.map.map((i) => target.charAt(i)).join('');
    } else {
      this.map = null;
      this.cmpTarget = target;
    }
    // 英文文本（不含 CJK 字符）不区分大小写
    this.caseInsensitive = !/[㐀-鿿豈-﫿]/.test(target);
    this.norm = this.caseInsensitive
      ? (c) => c.toLowerCase()
      : (c) => c;
    this.value = '';
    this.typed = 0;   // 累计提交的字符数（含修改重打的）
    this.errors = 0;  // 累计打错的字符数
  }

  setValue(raw) {
    let str = String(raw);
    // 数字模式：空格只是分组展示，玩家输了空格也直接忽略，不算错
    if (this.skipSpaces) str = str.replace(/ /g, '');
    const next = str.slice(0, this.cmpTarget.length);
    const prevLength = this.value.length;
    if (next.length > prevLength) {
      for (let i = prevLength; i < next.length; i += 1) {
        this.typed += 1;
        if (this.norm(next[i]) !== this.norm(this.cmpTarget.charAt(i))) this.errors += 1;
      }
    }
    this.value = next;
  }

  get length() {
    return this.value.length;
  }

  get progress() {
    if (!this.cmpTarget.length) return 0;
    return this.value.length / this.cmpTarget.length;
  }

  correctChars() {
    let count = 0;
    for (let i = 0; i < this.value.length; i += 1) {
      if (this.norm(this.value[i]) === this.norm(this.cmpTarget.charAt(i))) count += 1;
    }
    return count;
  }

  accuracy() {
    if (!this.typed) return 100;
    const raw = ((this.typed - this.errors) / this.typed) * 100;
    return Math.max(0, Math.round(raw * 10) / 10);
  }
}
