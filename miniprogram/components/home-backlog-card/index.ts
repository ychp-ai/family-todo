import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    batchMode: { type: Boolean, value: false },
    writing: { type: Boolean, value: false },
    item: { type: Object, value: null }
  },
  methods: componentMethods(["openTask", "toggleTask"]),
});
