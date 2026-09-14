import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    today: { type: String, value: "" },
    tab: { type: String, value: "" },
    selectedDate: { type: String, value: "" }
  },
  methods: componentMethods(["changeTab", "pickDate"]),
});
