import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    family: { type: Object, value: null },
    owner: { type: Boolean, value: false },
    writing: { type: Boolean, value: false },
    uncertain: { type: Boolean, value: false }
  },
  methods: componentMethods(["create"]),
});
