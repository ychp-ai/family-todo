import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    preview: { type: Array, value: [] },
    previewExplanation: { type: String, value: "" },
    previewLoading: { type: Boolean, value: false },
    previewError: { type: String, value: "" }
  },
  methods: componentMethods(["previewSchedule"]),
});
