import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    hasTimes: { type: Boolean, value: false },
    task: { type: Object, value: null },
    occurrence: { type: Object, value: null },
    viewerNames: { type: String, value: "" },
    helperNames: { type: String, value: "" }
  },
  methods: componentMethods([]),
});
