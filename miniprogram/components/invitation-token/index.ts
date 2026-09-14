import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    generatedToken: { type: String, value: "" },
    expiresLabel: { type: String, value: "" }
  },
  methods: componentMethods(["copyPath", "copyToken"]),
});
