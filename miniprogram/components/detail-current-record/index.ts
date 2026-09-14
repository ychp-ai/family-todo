import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    occurrence: { type: Object, value: null },
    completionLabel: { type: String, value: "" },
    recordedLabel: { type: String, value: "" },
    actualLabel: { type: String, value: "" }
  },
  methods: componentMethods([]),
});
