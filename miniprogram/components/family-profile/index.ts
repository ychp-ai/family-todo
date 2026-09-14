import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    avatarPath: { type: String, value: "" },
    displayName: { type: String, value: "" },
    avatarInitial: { type: String, value: "" }
  },
  methods: componentMethods(["avatarError", "openProfile"]),
});
