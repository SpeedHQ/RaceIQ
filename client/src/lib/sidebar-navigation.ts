export function isGameContextPath(pathname: string, routePrefixes: readonly string[]): boolean {
  return routePrefixes.some((routePrefix) => pathname === `/${routePrefix}` || pathname.startsWith(`/${routePrefix}/`));
}
export function replaceGameRoutePrefix(pathname: string, currentRoutePrefix: string, nextRoutePrefix: string): string {
  const currentPathPrefix = `/${currentRoutePrefix}`;
  if (pathname === currentPathPrefix) return `/${nextRoutePrefix}`;
  if (!pathname.startsWith(`${currentPathPrefix}/`)) return pathname;
  const pageRoot = pathname.slice(currentPathPrefix.length).split("/")[1];
  return pageRoot === "analyse" ? `/${nextRoutePrefix}/sessions` : pageRoot ? `/${nextRoutePrefix}/${pageRoot}` : `/${nextRoutePrefix}`;
}
