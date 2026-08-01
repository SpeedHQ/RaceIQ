import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Table, TBody, TD, TH, THead, TRow } from "../src/components/ui/AppTable";

const consumerOverrides = {
  className: "consumer-override",
  style: { color: "rgb(255, 0, 0)" },
};

describe("AppTable styling contract", () => {
  test("drops class and style overrides from every table primitive", () => {
    const markup = renderToStaticMarkup(
      <Table {...consumerOverrides} tableClassName="table-override">
        <THead {...consumerOverrides} rowClassName="row-override">
          <TH {...consumerOverrides}>Heading</TH>
        </THead>
        <TBody {...consumerOverrides}>
          <TRow {...consumerOverrides}>
            <TD {...consumerOverrides}>Value</TD>
          </TRow>
        </TBody>
      </Table>,
    );

    expect(markup).not.toContain("consumer-override");
    expect(markup).not.toContain("table-override");
    expect(markup).not.toContain("row-override");
    expect(markup).not.toContain("rgb(255,0,0)");
    expect(markup).toContain("w-full text-app-detail");
    expect(markup).toContain("px-3 py-2");
  });

  test("maps semantic table props to component-owned styles", () => {
    const markup = renderToStaticMarkup(
      <Table density="compact" fit variant="embedded">
        <THead>
          <TH align="end" nowrap>
            Heading
          </TH>
        </THead>
        <TBody>
          <TRow selected>
            <TD align="end" emphasis numeric nowrap tone="success" truncate="narrow">
              Value
            </TD>
          </TRow>
        </TBody>
      </Table>,
    );

    expect(markup).toContain('data-density="compact"');
    expect(markup).toContain('data-variant="embedded"');
    expect(markup).toContain('data-selected="true"');
    expect(markup).toContain("text-right");
    expect(markup).toContain("font-mono");
    expect(markup).toContain("text-status-success");
    expect(markup).toContain("max-w-[140px]");
    expect(markup).toMatch(/<th[^>]*whitespace-nowrap[^>]*>Heading/);
    expect(markup).not.toContain('nowrap=""');
    expect(markup).not.toContain('align="end"');
    expect(markup).not.toContain('tone="success"');
  });
});
