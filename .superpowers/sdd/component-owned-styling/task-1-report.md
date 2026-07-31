
## Review fixes
- Implemented DialogContent `layout="scrollable"` behavior with max-height and overflow styling.
- Implemented actual AppTable `settings` shell styling.
- Exported TabsListProps and TabsTriggerProps now include semantic variant unions.
- Removed duplicate/no-op Tabs `settings` alias; retained `default` and differentiated `pills`.
- Expanded SemanticVariants Storybook coverage to Card, Dialog, Tabs, and Table with observable assertions.

Focused verification rerun: `cd client && bun run build-storybook` passed successfully.
