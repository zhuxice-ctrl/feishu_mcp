import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
export const javaDevelopmentSchema = z.object({ action: z.enum(["maven_test", "maven_package", "maven_clean_test", "gradle_test", "gradle_build", "gradle_assemble_debug"]), workspaceId: z.string(), contextId: z.string(), workdir: z.string() }).strict();
export type JavaDevelopmentInput = z.infer<typeof javaDevelopmentSchema>;
export function parseJavaDevelopment(value: unknown): JavaDevelopmentInput { return javaDevelopmentSchema.parse(value); }
export function buildJavaPlan(input: JavaDevelopmentInput, root: string, tools = process.env) {
  const gradle = input.action.startsWith("gradle_");
  const task = input.action === "gradle_test" ? "test" : input.action === "gradle_build" ? "build" : input.action === "gradle_assemble_debug" ? "assembleDebug" : input.action === "maven_test" ? "test" : input.action === "maven_package" ? "package" : "clean test";
  if (gradle) { const wrapper = process.platform === "win32" ? "gradlew.bat" : "gradlew"; if (!fs.existsSync(path.join(root, wrapper))) throw new Error("Gradle wrapper not found"); return { executable: process.platform === "win32" ? (tools.ComSpec || "cmd.exe") : path.join(root, wrapper), args: process.platform === "win32" ? ["/d", "/s", "/c", `${wrapper} ${task}`] : [task] }; }
  return { executable: process.platform === "win32" ? (tools.ComSpec || "cmd.exe") : "mvn", args: process.platform === "win32" ? ["/d", "/s", "/c", `mvn.cmd ${task}`] : task.split(" ") };
}
