import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    latest: { type: Object, value: null }
  },
  methods: componentMethods(["keepDraft", "loadLatest"]),
});
