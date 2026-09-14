import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    expiresLabel: { type: String, value: "" },
    myName: { type: String, value: "" },
    preview: { type: Object, value: null },
    writing: { type: Boolean, value: false },
    uncertain: { type: Boolean, value: false }
  },
  methods: componentMethods(["accept", "nameInput"]),
});
