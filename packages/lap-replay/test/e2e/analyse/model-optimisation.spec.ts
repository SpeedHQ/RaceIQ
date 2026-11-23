import { test, expect } from "@playwright/test";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import { getSeededLapMeta } from "../../../../../playwright/tests/support/seeded/laps";

test("save a separate stripped copy without assigning or replacing the source", async ({ page, request }) => {
  const doc = new Document();
  doc.createBuffer();
  const scene = doc.createScene();
  const paint = doc.createMaterial("Livery").setDoubleSided(true).setBaseColorFactor([1, 0.2, 0.1, 1]);
  for (const [i, name] of ["Body", "Spoiler"].entries()) {
    const pos = doc
      .createAccessor()
      .setType("VEC3")
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    scene.addChild(
      doc
        .createNode(name)
        .setTranslation([i, 0, 0])
        .setMesh(doc.createMesh().addPrimitive(doc.createPrimitive().setMaterial(paint).setAttribute("POSITION", pos))),
    );
  }
  const bytes = Buffer.from(await new NodeIO().writeBinary(doc));
  await page.goto("/car-models", { waitUntil: "domcontentloaded" });
  const upload = () => page.locator("input[type=file]").setInputFiles({ name: "Club racer.glb", mimeType: "model/gltf-binary", buffer: bytes });
  const editor = page.getByRole("dialog", { name: /Optimise model:/ }),
    save = editor.getByRole("button", { name: "Save copy" });
  const original = page.getByRole("listitem").filter({ has: page.getByText("Club racer", { exact: true }) });
  await upload();
  await expect(save).toBeEnabled();
  await expect(editor.getByText("Original: " + bytes.length.toLocaleString() + " B", { exact: true })).toBeVisible();
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(original).toHaveCount(0);
  await upload();
  await save.click();
  await original.getByRole("button", { name: "Optimise model" }).click();
  await expect(save).toBeEnabled();
  await editor.getByText("Remove parts", { exact: true }).click();
  await editor.getByLabel("Spoiler").check();
  await editor.getByLabel("Replay only:", { exact: false }).check();
  await expect(save).toBeEnabled();
  await editor.getByLabel("Body", { exact: true }).check();
  await expect(save).toBeDisabled();
  await expect(editor.getByRole("alert")).toBeVisible();
  await editor.getByLabel("Body", { exact: true }).uncheck();
  await save.click();
  await page.reload({ waitUntil: "domcontentloaded" });
  const copyName = "Club racer (Optimised)";
  await expect(original).toBeVisible();
  await expect(page.getByText(copyName, { exact: true })).toBeVisible();
  const rows = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("raceiq-car-models");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      const rows = await new Promise<{ name: string; blob: Blob }[]>((resolve, reject) => {
        const r = db.transaction("models").objectStore("models").getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      return Promise.all(rows.map(async (r) => ({ name: r.name, bytes: Array.from(new Uint8Array(await r.blob.arrayBuffer())) })));
    } finally {
      db.close();
    }
  });
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  for (const row of rows) {
    const root = (await io.readBinary(Uint8Array.from(row.bytes))).getRoot();
    const names = root.listNodes().map((n) => n.getName());
    if (row.name === copyName) {
      expect(root.listMaterials()).toHaveLength(0);
      expect(names).not.toContain("Spoiler");
    } else {
      expect(root.listMaterials().map((m) => m.getName())).toContain("Livery");
      expect(names).toContain("Spoiler");
    }
  }
  const lap = await getSeededLapMeta(request, "fm-2023");
  await page.goto("/fm23/sessions/" + lap.sessionId + "/replay/" + lap.id + "?forceWebGL=true", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-replay-scene] canvas[data-a-model-path]")).toHaveAttribute("data-a-model-path", /models\//, { timeout: 60000 });
  await page.getByRole("button", { name: "Car model", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Car model" }).getByRole("combobox");
  await expect(picker).toHaveValue("");
  await picker.selectOption({ label: copyName });
  await page.getByRole("button", { name: "Use for this car" }).click();
  await expect(page.locator("[data-replay-scene] canvas[data-a-model-path]")).toHaveAttribute("data-a-model-path", /^blob:/);
});
