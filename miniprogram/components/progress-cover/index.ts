import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    familyName: { type: String, value: "" },
    memberCaption: { type: String, value: "" },
    portraits: { type: Array, value: [] }
  },
  methods: componentMethods([]),
});
