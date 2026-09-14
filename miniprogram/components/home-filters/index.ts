import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    batchMode: { type: Boolean, value: false },
    familyOptions: { type: Array, value: [] },
    familyIndex: { type: Number, value: 0 }
  },
  methods: componentMethods(["familyChange", "futureFeature"]),
});
