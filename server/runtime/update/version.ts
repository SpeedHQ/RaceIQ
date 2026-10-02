/** Returns true if version string `a` is strictly newer than `b`. */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [am, an, ap] = parse(a);
  const [bm, bn, bp] = parse(b);
  if (am !== bm) return am > bm;
  if (an !== bn) return an > bn;
  return ap > bp;
}
