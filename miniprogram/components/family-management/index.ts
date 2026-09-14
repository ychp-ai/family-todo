import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    detail: { type: Boolean, value: false },
    families: { type: Array, value: [] }
  },
  methods: componentMethods(["join", "openCreate", "progress", "recycle"]),
});
