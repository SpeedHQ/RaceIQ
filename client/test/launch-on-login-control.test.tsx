import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LaunchOnLoginControl } from "../src/components/settings/general/LaunchOnLoginControl";
import { GeneralSection } from "../src/components/settings/general/GeneralSection";
import { StartupStep } from "../src/components/onboarding/steps/StartupStep";
import { queryKeys } from "../src/hooks/query-keys";
import { m } from "../src/paraglide/messages";

const desktopOwnedText = renderToStaticMarkup(
  createElement(Fragment, null, m.settings_launch_desktop_owned()),
);

function render(desktopOwned: boolean, supported: boolean, checked = false) {
  return renderToStaticMarkup(createElement(LaunchOnLoginControl, {
    desktopOwned, supported, checked, onChange: () => {},
  }));
}

describe("launch on login control", () => {
  test("general settings and onboarding both defer desktop startup to the menu", () => {
    for (const Component of [GeneralSection, StartupStep]) {
      const queryClient = new QueryClient();
      queryClient.setQueryData(queryKeys.settings, {
        isCompiled: true, launchOnLoginOwner: "desktop", launchOnLoginSupported: false, launchOnLogin: true,
      });
      const html = renderToStaticMarkup(
        createElement(QueryClientProvider, { client: queryClient, children: createElement(Component) }),
      );
      expect(html).toContain(desktopOwnedText);
      expect(html).not.toContain('role="switch"');
      expect(html).not.toContain(m.ob_startup_desc());
      expect(html).not.toContain(m.settings_launch_on_login_desc());
    }
  });

  test("desktop ownership shows menu guidance and no competing backend switch, even if supported or previously enabled", () => {
    for (const supported of [false, true]) {
      const html = render(true, supported, true);
      expect(html).toContain(desktopOwnedText);
      expect(html).not.toContain('role="switch"');
      expect(html).not.toContain(m.common_enabled());
    }
  });

  test("supported backend retains the switch and its checked state", () => {
    const html = render(false, true, true);
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).not.toContain('disabled=""');
    expect(html).toContain(m.common_enabled());
  });

  test("unsupported backend shows a disabled switch", () => {
    const html = render(false, false);
    expect(html).toContain('role="switch"');
    expect(html).toContain('disabled=""');
    expect(html).toContain(m.settings_launch_installed_only());
  });
});
