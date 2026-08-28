export function isGameContextPath(pathname: string, routePrefixes: readonly string[]): boolean {
  return routePrefixes.some((routePrefix) => pathname === `/${routePrefix}` || pathname.startsWith(`/${routePrefix}/`));
}
