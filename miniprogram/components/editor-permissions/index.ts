import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    repeat: { type: String, value: "" },
    times: { type: Array, value: [] },

    time: { type: String, value: "" },
    remindMe: { type: Boolean, value: false },
    saving: { type: Boolean, value: false },
    uncertain: { type: Boolean, value: false },
    rows: { type: Array, value: [] }
  },
  methods: componentMethods(["permissionChange", "reminderChange"]),
});
