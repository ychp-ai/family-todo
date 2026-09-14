import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    progressLoading: { type: Boolean, value: false },
    progressError: { type: String, value: "" },
    owner: { type: Boolean, value: false },
    item: { type: Object, value: null }
  },
  methods: componentMethods(["renameMember", "startExit"]),
});
