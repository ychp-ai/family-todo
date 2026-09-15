import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  data: { managing: false },
  properties: {
    progressLoading: { type: Boolean, value: false },
    progressError: { type: String, value: "" },
    owner: { type: Boolean, value: false },
    item: { type: Object, value: null }
  },
  methods: {
    toggleManagement() { this.setData({ managing: !this.data.managing }); },
    ...componentMethods(["renameMember", "startExit"]),
  },
});
