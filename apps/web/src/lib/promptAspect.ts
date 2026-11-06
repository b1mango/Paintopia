/** 画幅可选的宽高比（砚台的画幅浮层与提示词识别共用）。 */
export const ASPECT_RATIOS = [["1:1", 1, 1], ["2:3", 2, 3], ["3:2", 3, 2], ["3:4", 3, 4], ["4:3", 4, 3], ["9:16", 9, 16], ["16:9", 16, 9], ["9:21", 9, 21], ["21:9", 21, 9]] as const;

type Orientation = "portrait" | "landscape" | "square";

export interface PromptAspectMatch {
  /** 建议切换到的画幅。 */
  ratio: string;
  /** 提示词里命中的原文（16:9、竖屏…）。 */
  text: string;
  /** 与 text 方向相反的方向词原文（如「Vertical 16:9」里的 Vertical），此时 ratio 已按方向词翻转。 */
  conflict?: string;
  /** 只写了方向（竖屏、vertical composition…），没给具体比例：画幅方向一致就不必提示。 */
  loose?: boolean;
}

/** 与最接近的可选比例相差超过 5% 就不认（避免把 12:30 这类时间当成比例）。 */
const TOLERANCE = Math.log(1.05);
const RATIO = String.raw`\d{1,2}(?:\.\d{1,2})?\s*(?::|：|比)\s*\d{1,2}(?:\.\d{1,2})?`;
// 显式比例：16:9、16：9、16比9、--ar 2.35:1；前后不能紧挨数字，避免截到更长的数
const EXPLICIT = /(?<![\d.])(\d{1,2}(?:\.\d{1,2})?)\s*(?::|：|比)\s*(\d{1,2}(?:\.\d{1,2})?)(?![\d.])/g;
// 像素尺寸：1920x1080、1080×1920、1024*1024
const PIXELS = /(?<!\d)(\d{3,4})\s*[x×X*]\s*(\d{3,4})(?!\d)/g;
// 具体用途：直接对应一个比例
const KEYWORDS: [RegExp, string][] = [
  [/宽银幕|超宽屏|电影宽画幅/, "21:9"],
  [/手机壁纸|手机屏保/, "9:16"],
  [/电脑壁纸|桌面壁纸/, "16:9"],
  [/正方形构图|正方形画幅|方图|方形构图/, "1:1"],
];
// 只表示方向。英文只认带构图/画幅含义的搭配（vertical stripes、portrait of a cat 不算）；中文不收「横幅」「竖起」这类歧义词
const ORIENTATION_WORDS: [RegExp, Orientation][] = [
  [/竖屏|竖版|竖构图|竖幅|竖画幅|竖向构图|纵向构图/, "portrait"],
  [new RegExp(String.raw`\b(vertical)(?:\s+${RATIO}(?![\d.])|(?:\s+${RATIO})?\s+(?:composition|format|orientation|layout|frame|framing|canvas|aspect|poster|wallpaper|image|shot|photo)\b)`, "i"), "portrait"],
  [new RegExp(String.raw`\b(portrait)(?:\s+${RATIO})?\s+(?:orientation|format|layout|mode|aspect|canvas)\b|\b(portrait)-oriented\b`, "i"), "portrait"],
  [/横屏|横版|横构图|横画幅|横向构图|宽屏/, "landscape"],
  [new RegExp(String.raw`\b(horizontal)(?:\s+${RATIO}(?![\d.])|(?:\s+${RATIO})?\s+(?:composition|format|orientation|layout|frame|framing|canvas|aspect|poster|wallpaper|image|shot|photo)\b)`, "i"), "landscape"],
  [new RegExp(String.raw`\b(landscape)(?:\s+${RATIO})?\s+(?:orientation|format|layout|mode|aspect|canvas)\b|\b(landscape)-oriented\b|\b(widescreen)\b`, "i"), "landscape"],
];
const ORIENTATION_RATIO: Record<Orientation, string> = { portrait: "9:16", landscape: "16:9", square: "1:1" };

function nearestRatio(width: number, height: number): string | null {
  if (!(width > 0 && height > 0)) return null;
  const target = Math.log(width / height);
  let best: string | null = null;
  let distance = TOLERANCE;
  for (const [ratio, w, h] of ASPECT_RATIOS) {
    const delta = Math.abs(Math.log(w / h) - target);
    if (delta <= distance) { best = ratio; distance = delta; }
  }
  return best;
}

function ratioOrientation(ratio: string): Orientation | null {
  if (ratio === "auto") return null;
  const [w, h] = ratio.split(":").map(Number);
  return w === h ? "square" : w > h ? "landscape" : "portrait";
}

function orientationWord(prompt: string) {
  for (const [pattern, orientation] of ORIENTATION_WORDS) {
    const match = prompt.match(pattern);
    // 英文只展示方向词本身（Vertical），中文展示整个词（竖屏）
    if (match) return { orientation, text: match.slice(1).find(Boolean) ?? match[0] };
  }
  return null;
}

/** 从提示词里识别画幅：显式比例优先，其次像素尺寸，再是「手机壁纸」这类用途，最后是「竖屏」「vertical composition」这类方向。
 * 显式比例与方向词相反时（Vertical 16:9），按方向词翻转比例并标出矛盾：上游常按方向词选画布再硬缩放到请求尺寸，画面会被拉伸。
 * 纯本地正则，打字时也能即时判断。 */
export function detectPromptAspectRatio(prompt: string): PromptAspectMatch | null {
  for (const pattern of [EXPLICIT, PIXELS]) {
    for (const match of prompt.matchAll(pattern)) {
      const ratio = nearestRatio(Number(match[1]), Number(match[2]));
      if (!ratio) continue;
      const text = match[0].trim();
      const word = orientationWord(prompt);
      const own = ratioOrientation(ratio);
      if (word && own !== "square" && word.orientation !== own) return { ratio: ratio.split(":").reverse().join(":"), text, conflict: word.text };
      return { ratio, text };
    }
  }
  for (const [pattern, ratio] of KEYWORDS) {
    const match = prompt.match(pattern);
    if (match) return { ratio, text: match[0] };
  }
  const word = orientationWord(prompt);
  return word ? { ratio: ORIENTATION_RATIO[word.orientation], text: word.text, loose: true } : null;
}

/** 当前画幅下是否值得提示：已是建议比例不提示；只写了方向时，方向一致也不提示。 */
export function needsAspectHint(match: PromptAspectMatch, current: string) {
  if (match.ratio === current) return false;
  return !match.loose || ratioOrientation(current) !== ratioOrientation(match.ratio);
}
