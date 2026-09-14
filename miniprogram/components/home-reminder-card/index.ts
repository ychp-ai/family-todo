import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    writing: { type: Boolean, value: false },
    item: { type: Object, value: null }
  },
  methods: componentMethods(["dismissReminder", "reminderDetail"]),
});
