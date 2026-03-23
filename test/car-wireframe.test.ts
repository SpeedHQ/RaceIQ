import { describe, test, expect } from "bun:test";
import { classifyMesh, DEFAULT_HIDDEN_MESHES } from "../client/src/components/CarWireframe";

// Real mesh names from the Aston Martin Vantage GT3 GLB
const ALL_MESHES = [
  "Object_7", "Object_8", "Object_9", "Object_68", "Object_69", "Object_70",
  "Object_71", "Object_72", "Object_73", "Object_74", "Object_76", "Object_77",
  "Object_78", "Object_79", "Object_80", "Object_81", "Object_82", "Object_84",
  "Object_85", "Object_86", "Object_87", "Object_88", "Object_89", "Object_90",
  "Object_92", "Object_94", "Object_96", "Object_97", "Object_98", "Object_99",
  "Object_100", "Object_101", "Object_102", "Object_104", "Object_105", "Object_106",
  "Object_107", "Object_109", "Object_110", "Object_111", "Object_112", "Object_114",
  "Object_115", "Object_116", "Object_117", "Object_119", "Object_120", "Object_122",
  "Object_123", "Object_125", "Object_126", "Object_128", "Object_129", "Object_130",
  "Object_131", "Object_132", "Object_134", "Object_135", "Object_136", "Object_137",
  "Object_138", "Object_139", "Object_140", "Object_142", "Object_143", "Object_144",
  "Object_145", "Object_147", "Object_149", "Object_150", "Object_152", "Object_154",
  "Object_155", "Object_156", "Object_157", "Object_158", "Object_159", "Object_161",
  "Object_163", "Object_164", "Object_165", "Object_166", "Object_167", "Object_168",
  "Object_170", "Object_171", "Object_172", "Object_174", "Object_175", "Object_177",
  "Object_178", "Object_180", "Object_181", "Object_183", "Object_184", "Object_186",
  "Object_187", "Object_188", "Object_189", "Object_191", "Object_192", "Object_194",
  "Object_195", "Object_196", "Object_197", "Object_199", "Object_200", "Object_201",
  "Object_202", "Object_204", "Object_205", "Object_206", "Object_207", "Object_209",
  "Object_211", "Object_212", "Object_214", "Object_215", "Object_217", "Object_219",
];

const WHEEL_MESH_NAMES = [...DEFAULT_HIDDEN_MESHES].map((n) => `Object_${n}`);
const BODY_MESH_NAMES = ALL_MESHES.filter((name) => !WHEEL_MESH_NAMES.includes(name));

describe("classifyMesh", () => {
  describe("hidden mode removes all meshes", () => {
    test("wheel meshes are removed", () => {
      for (const name of WHEEL_MESH_NAMES) {
        expect(classifyMesh(name, "hidden", false)).toBe("remove");
      }
    });

    test("body meshes are removed", () => {
      for (const name of BODY_MESH_NAMES) {
        expect(classifyMesh(name, "hidden", false)).toBe("remove");
      }
    });
  });

  describe("solid mode", () => {
    test("wheel meshes are removed", () => {
      for (const name of WHEEL_MESH_NAMES) {
        expect(classifyMesh(name, "solid", false)).toBe("remove");
      }
    });

    test("body meshes get solid material", () => {
      for (const name of BODY_MESH_NAMES) {
        expect(classifyMesh(name, "solid", false)).toBe("solid");
      }
    });
  });

  describe("wire mode without hideModelWheels (car viewer)", () => {
    test("wheel meshes are NOT removed", () => {
      for (const name of WHEEL_MESH_NAMES) {
        expect(classifyMesh(name, "wire", false)).toBe("wire");
      }
    });

    test("body meshes get wire material", () => {
      for (const name of BODY_MESH_NAMES) {
        expect(classifyMesh(name, "wire", false)).toBe("wire");
      }
    });
  });

  describe("wire mode with hideModelWheels (analyse view)", () => {
    test("wheel meshes are removed", () => {
      for (const name of WHEEL_MESH_NAMES) {
        expect(classifyMesh(name, "wire", true)).toBe("remove");
      }
    });

    test("body meshes get wire material", () => {
      for (const name of BODY_MESH_NAMES) {
        expect(classifyMesh(name, "wire", true)).toBe("wire");
      }
    });
  });

  describe("custom solidHiddenMeshes", () => {
    const customHidden = [68, 69, 70];

    test("uses custom set instead of defaults", () => {
      expect(classifyMesh("Object_68", "solid", false, customHidden)).toBe("remove");
      expect(classifyMesh("Object_69", "solid", false, customHidden)).toBe("remove");
      expect(classifyMesh("Object_70", "solid", false, customHidden)).toBe("remove");
    });

    test("default wheel meshes are NOT removed when custom set is provided", () => {
      expect(classifyMesh("Object_94", "solid", false, customHidden)).toBe("solid");
      expect(classifyMesh("Object_211", "solid", false, customHidden)).toBe("solid");
    });

    test("empty custom array falls back to defaults", () => {
      expect(classifyMesh("Object_94", "solid", false, [])).toBe("remove");
      expect(classifyMesh("Object_211", "solid", false, [])).toBe("remove");
    });
  });

  describe("specific wheel meshes from Aston Martin GT3", () => {
    const knownWheelNumbers = [94, 125, 126, 161, 183, 184, 211, 212, 214, 215, 217, 219];

    test("all known wheel/rim/disc meshes are removed in solid mode", () => {
      for (const num of knownWheelNumbers) {
        const result = classifyMesh(`Object_${num}`, "solid", false);
        expect(result).toBe("remove");
      }
    });

    test("all known wheel/rim/disc meshes are removed in wire+analyse mode", () => {
      for (const num of knownWheelNumbers) {
        const result = classifyMesh(`Object_${num}`, "wire", true);
        expect(result).toBe("remove");
      }
    });
  });
});
