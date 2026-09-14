import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    token: { type: String, value: "" },
    writing: { type: Boolean, value: false },
    uncertain: { type: Boolean, value: false }
  },
  methods: componentMethods(["previewInvitation", "tokenInput"]),
});
