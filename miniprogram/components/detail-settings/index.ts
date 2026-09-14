import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    task: { type: Object, value: null },
    writing: { type: Boolean, value: false }
  },
  methods: componentMethods(["deleteTask", "edit", "recycle", "share", "toggleReminder"]),
});
