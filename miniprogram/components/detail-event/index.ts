import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    item: { type: Object, value: null }
  },
  methods: componentMethods([]),
});
