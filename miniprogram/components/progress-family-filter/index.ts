import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    families: { type: Array, value: [] },
    familyId: { type: String, value: "" }
  },
  methods: componentMethods(["familyChange"]),
});
