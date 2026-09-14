import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    familyOptions: { type: Array, value: [] },
    familyIndex: { type: Number, value: 0 },
    writing: { type: Boolean, value: false }
  },
  methods: componentMethods(["familyChange"]),
});
