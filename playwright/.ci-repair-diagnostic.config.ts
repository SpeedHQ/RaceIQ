import config from "./playwright.config";
const project = config.projects!.find(project => project.name === "lap-replay-webgpu")!;
project.use = { ...project.use, launchOptions: { args: ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--use-webgpu-adapter=swiftshader", "--enable-logging=stderr"] } };
export default config;
