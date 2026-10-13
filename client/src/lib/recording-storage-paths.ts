export function previewRecordingDirectories(root: string): { own: string; others: string } | null {
  if (!root.trim()) return null;
  const windows = /^[A-Za-z]:/.test(root) || root.startsWith("\\\\");
  const separator = windows ? "\\" : "/";
  const normalized = windows ? root.replaceAll("/", "\\") : root;
  const base = windows ? normalized.replace(/\\+$/, "") : normalized.replace(/\/+$/, "");
  const prefix = `${base}${separator}`;
  return { own: `${prefix}<game>${separator}own`, others: `${prefix}<game>${separator}others` };
}
