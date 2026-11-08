export function previewRecordingDirectories(root: string): { own: string; others: string } | null {
  if (!root.trim()) return null;
  const windows = /^[A-Za-z]:/.test(root) || root.startsWith("\\\\");
  const separator = windows ? "\\" : "/";
  return { own: `<game>${separator}own`, others: `<game>${separator}others` };
}
