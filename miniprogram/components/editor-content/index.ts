import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    title: { type: String, value: "" },
    note: { type: String, value: "" },
    saving: { type: Boolean, value: false },
    uncertain: { type: Boolean, value: false },
    shareOnly: { type: Boolean, value: false }
  },
  methods: componentMethods(["noteInput", "titleInput"]),
});
