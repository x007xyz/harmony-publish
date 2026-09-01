import { cli, Strategy } from "@jackwener/opencli/registry";
import { SITE, AGC_HOME, APP_INFO_ROUTE, clickByText, frameClick, projectConfig, resolveAppId } from "./shared.js";
import { CommandExecutionError } from "@jackwener/opencli/errors";


cli({
  site: SITE,
  name: "set-app-info-phone-only-ui",
  description: "UI fallback for limiting AppGallery supported devices to phone",
  access: "write",
  domain: "developer.huawei.com",
  strategy: Strategy.UI,
  browser: true,
  siteSession: "persistent",
  defaultWindowMode: "foreground",
  navigateBefore: false,
  defaultFormat: "json",
  columns: ["status", "devices", "saved"],
  func: async (page, args) => {
    const cfg = projectConfig(args);
    const APP_INFO_URL = `${AGC_HOME}#/myApp/${await resolveAppId(page, cfg)}/${APP_INFO_ROUTE}`;
    await page.goto(APP_INFO_URL, { waitUntil: "load", settleMs: 4000 });
    await page.wait({ time: 7 });
    const changed = await page.evaluate(() => {
      const doc = document.querySelector("#mainIframeView")?.contentDocument;
      const group = Array.from(doc?.querySelectorAll(".el-form-item.is-required") || [])
        .find((node) => String(node.querySelector(".el-form-item__label")?.innerText || "").includes("支持设备"));
      if (!group) return false;
      const phone = group.querySelector('input[type="checkbox"][value="4"]');
      return { hasGroup: true, phoneChecked: Boolean(phone?.checked) };
    });
    if (!changed) throw new CommandExecutionError("Could not restore phone-only device selection");
    // 取消勾选除手机(4)外的已选设备
    for (;;) {
      const target = await frameClick(page, (doc) => {
        const group = Array.from(doc.querySelectorAll(".el-form-item.is-required"))
          .find((node) => String(node.querySelector(".el-form-item__label")?.innerText || "").includes("支持设备"));
        const input = Array.from(group?.querySelectorAll('input[type="checkbox"]') || [])
          .find((node) => node.value !== "4" && node.checked && !node.disabled);
        if (!input) return null;
        return input.closest("label") || input.closest(".el-checkbox") || input;
      });
      if (!target) break;
      await page.wait({ time: 1 });
    }
    await page.wait({ time: 2 });
    const saved = await frameClick(page, (doc) => {
      const save = doc?.querySelector("#SaveButton");
      if (!save || save.hasAttribute("disabled")) return null;
      return save;
    });
    if (!saved) throw new CommandExecutionError("Application-info Save button is unavailable");
    await page.wait({ time: 8 });
    const state = await page.evaluate(() => {
      const doc = document.querySelector("#mainIframeView")?.contentDocument;
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const group = Array.from(doc?.querySelectorAll(".el-form-item.is-required") || [])
        .find((node) => clean(node.querySelector(".el-form-item__label")?.innerText).includes("支持设备"));
      const devices = Array.from(group?.querySelectorAll('input[type="checkbox"]') || [])
        .filter((input) => input.checked)
        .map((input) => clean(input.closest("label")?.innerText));
      return { devices, body: clean(doc?.body?.innerText).slice(-5000) };
    });
    if (state.devices.length !== 1 || state.devices[0] !== "手机") {
      throw new CommandExecutionError(`Phone-only selection was not saved: ${state.devices.join(", ")}`);
    }
    return [{
      status: "saved",
      devices: "手机",
      saved: /保存成功/.test(state.body),
    }];
  },
});
