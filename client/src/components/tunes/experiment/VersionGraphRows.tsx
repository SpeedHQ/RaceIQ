import type { ReactNode } from "react";
import type { ExperimentVersion } from "@/hooks/experiments";

/** Render version forest recursively, keeping graph branch indentation in one owner. */
export function RecursiveVersionRows({
  roots,
  childrenOf,
  renderNode,
}: {
  roots: ExperimentVersion[];
  childrenOf: Map<number, ExperimentVersion[]>;
  renderNode: (node: ExperimentVersion, depth: number, isLastSibling: boolean) => ReactNode;
}) {
  const visited = new Set<number>();
  const renderBranch = (node: ExperimentVersion, depth: number, isLastSibling: boolean): ReactNode => {
    if (visited.has(node.id)) return null;
    visited.add(node.id);
    const rendered = renderNode(node, depth, isLastSibling);
    const children = (childrenOf.get(node.id) ?? []).filter((child) => !visited.has(child.id));
    if (!children.length) return rendered;
    return (
      <>
        {rendered}
        <div className="ml-3 pl-3 border-l border-app-border">{children.map((child, index) => renderBranch(child, depth + 1, index === children.length - 1))}</div>
      </>
    );
  };
  return <>{roots.map((node, index) => renderBranch(node, 0, index === roots.length - 1))}</>;
}
