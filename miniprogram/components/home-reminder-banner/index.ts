import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    reminderCount: { type: Number, value: 0 },
    reminderError: { type: String, value: "" }
  },
  methods: componentMethods(["openReminders"]),
});
