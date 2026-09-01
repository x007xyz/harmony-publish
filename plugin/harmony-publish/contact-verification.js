import { cli, Strategy } from "@jackwener/opencli/registry";
import { CommandExecutionError } from "@jackwener/opencli/errors";
import { SITE, clickByText, frameClick, navigateVersionPage, projectConfig } from "./shared.js";


cli({
  site: SITE,
  name: "contact-verification-ui",
  description: "Request or verify the AppGallery reviewer-contact SMS code and save the version",
  access: "write",
  domain: "developer.huawei.com",
  strategy: Strategy.UI,
  browser: true,
  siteSession: "persistent",
  defaultWindowMode: "foreground",
  navigateBefore: false,
  defaultFormat: "json",
  args: [
    { name: "project", default: "", help: "projects.json key or project path (e.g. blur-face)" },
    { name: "stage", default: "request", choices: ["request", "verify"], help: "Request or verify the SMS code" },
    { name: "phone", default: "", help: "Mainland China mobile number" },
    { name: "email", default: "", help: "Reviewer contact email" },
    { name: "name", default: "", help: "Reviewer contact name" },
    { name: "code", default: "", help: "Six-digit SMS code for verify stage" },
  ],
  columns: ["status", "body", "dialogs"],
  func: async (page, args) => {
    const cfg = projectConfig(args);
    const stage = String(args.stage);
    if (stage === "request") {
      if (!/^1\d{10}$/.test(String(args.phone))) {
        throw new CommandExecutionError("A valid 11-digit mainland China mobile number is required");
      }
      if (!String(args.email).includes("@") || !String(args.name).trim()) {
        throw new CommandExecutionError("Reviewer email and name are required");
      }
      await navigateVersionPage(page, cfg);
      await page.wait({ time: 7 });
      const prepared = await page.evaluate((values) => {
        const doc = document.querySelector("#mainIframeView")?.contentDocument;
        const setValue = (node, value) => {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value")?.set;
          if (setter) setter.call(node, value);
          else node.value = value;
          node.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
          node.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
          node.dispatchEvent(new doc.defaultView.Event("blur", { bubbles: true }));
        };
        const phone = doc.querySelector('input[placeholder*="应用负责人手机号码"]');
        const email = doc.querySelector('input[placeholder*="应用负责人邮箱"]');
        const name = doc.querySelector('input[placeholder*="应用负责人姓名"]');
        if (!phone || !email || !name) return false;
        setValue(phone, values.phone);
        setValue(email, values.email);
        setValue(name, values.name);
        return true;
      }, {
        phone: String(args.phone),
        email: String(args.email),
        name: String(args.name),
      });
      if (!prepared) throw new CommandExecutionError("Reviewer contact fields are unavailable");
      await page.wait({ time: 2 });
      const requested = await clickByText(page, "获取验证码");
      if (!requested) throw new CommandExecutionError("SMS Get verification code button is unavailable");
      await page.wait({ time: 8 });
    }
    if (stage === "verify") {
      if (!/^\d{6}$/.test(String(args.code))) {
        throw new CommandExecutionError("A six-digit SMS code is required");
      }
      if (!/^1\d{10}$/.test(String(args.phone))
        || !String(args.email).includes("@")
        || !String(args.name).trim()) {
        throw new CommandExecutionError("Phone, reviewer email, and name are required to restore the verification form");
      }
      const hasLiveVerificationForm = await page.evaluate(() => {
        const doc = document.querySelector("#mainIframeView")?.contentDocument;
        return Boolean(
          doc?.querySelector('input[placeholder="请输入手机验证码"]')
          && Array.from(doc.querySelectorAll("button"))
            .some((node) => String(node.innerText || node.textContent).trim() === "提交验证")
        );
      });
      if (!hasLiveVerificationForm) {
        await navigateVersionPage(page, cfg);
        await page.wait({ time: 7 });
      }
      const verified = await page.evaluate((values) => {
        const doc = document.querySelector("#mainIframeView")?.contentDocument;
        const setValue = (node, value) => {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value")?.set;
          if (setter) setter.call(node, value);
          else node.value = value;
          node.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
          node.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
          node.dispatchEvent(new doc.defaultView.Event("blur", { bubbles: true }));
        };
        const phone = doc.querySelector('input[placeholder*="应用负责人手机号码"]');
        const email = doc.querySelector('input[placeholder*="应用负责人邮箱"]');
        const name = doc.querySelector('input[placeholder*="应用负责人姓名"]');
        const input = doc.querySelector('input[placeholder="请输入手机验证码"]');
        if (!phone || !email || !name || !input) return false;
        setValue(phone, values.phone);
        setValue(email, values.email);
        setValue(name, values.name);
        setValue(input, values.code);
        return true;
      }, {
        phone: String(args.phone),
        email: String(args.email),
        name: String(args.name),
        code: String(args.code),
      });
      if (!verified) throw new CommandExecutionError("SMS Submit verification button is unavailable");
      const submitted = await clickByText(page, "提交验证");
      if (!submitted) throw new CommandExecutionError("SMS Submit verification button is unavailable");
      await page.wait({ time: 8 });
      const save = await page.evaluate(() => {
        const doc = document.querySelector("#mainIframeView")?.contentDocument;
        const button = Array.from(doc?.querySelectorAll("button") || [])
          .find((node) => String(node.innerText || node.textContent).trim() === "保存");
        if (!button || button.hasAttribute("disabled")) return "disabled";
        return "enabled";
      });
      if (save === "enabled") {
        await clickByText(page, "保存");
      }
      if (save === "disabled") {
        const verificationState = await page.evaluate(() => {
          const doc = document.querySelector("#mainIframeView")?.contentDocument;
          const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
          return clean(doc?.body?.innerText).slice(-4000);
        });
        if (!/验证成功|保存成功/.test(verificationState)) {
          throw new CommandExecutionError("Version Save button is unavailable after contact verification");
        }
      }
      await page.wait({ time: 5 });
      await frameClick(page, (doc) => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const device = Array.from(doc.querySelectorAll('[role="dialog"],.el-dialog,.el-message-box'))
          .find((node) => clean(node.innerText).includes("软件包可支持分发的设备范围"));
        const ignore = Array.from(device?.querySelectorAll("button") || [])
          .find((node) => clean(node.innerText || node.textContent) === "忽略"
            && !node.hasAttribute("disabled"));
        return ignore || null;
      });
      await page.wait({ time: 10 });
    }
    const state = await page.evaluate(() => {
      const doc = document.querySelector("#mainIframeView")?.contentDocument;
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      return {
        body: clean(doc?.body?.innerText).slice(-10000),
        dialogs: Array.from(doc?.querySelectorAll('[role="dialog"],.el-dialog,.el-message-box') || [])
          .map((node) => clean(node.innerText).slice(0, 6000))
          .filter(Boolean),
        errors: Array.from(doc?.querySelectorAll(".el-form-item__error,[role=alert]") || [])
          .map((node) => clean(node.innerText || node.textContent))
          .filter(Boolean),
      };
    });
    return [{
      status: stage === "request" ? "sms_requested" : "contact_verified_and_saved",
      ...state,
    }];
  },
});
