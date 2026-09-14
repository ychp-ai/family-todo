import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    rosterLoading: { type: Boolean, value: false },
    saving: { type: Boolean, value: false },
    uncertain: { type: Boolean, value: false },
    familyOptions: { type: Array, value: [] },
    familyIndex: { type: Number, value: 0 },
    familyLocked: { type: Boolean, value: false },
    subjectNames: { type: Array, value: [] },
    subjectIndex: { type: Number, value: 0 },
    notice: { type: String, value: "" },
    scheduleLocked: { type: Boolean, value: false },
    subjectMetadataMissing: { type: Boolean, value: false },
    shareOnly: { type: Boolean, value: false }
  },
  methods: componentMethods(["familyChange", "load", "subjectChange"]),
});
