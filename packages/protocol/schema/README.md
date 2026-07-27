# Pinned external schemas

## Harbor ATIF v1.7

`harbor-atif-v1.7.schema.json` is the Pydantic validation schema generated
from Harbor commit `7db020ba5a5ceee918351dd8fc374d4d60bad442`:

- model:
  `src/harbor/models/trajectories/trajectory.py`
- semantic validator:
  `src/harbor/utils/trajectory_validator.py`
- repository:
  `https://github.com/harbor-framework/harbor`
- generated schema SHA-256:
  `dcef1989e05cac504ecf0972f49b15956cb4000e2645292a5a12cad5d58c5338`

Generation uses Pydantic's validation-mode JSON Schema:

```bash
PYTHONPATH=<harbor-checkout>/src uv run --no-project \
  --with 'pydantic==2.12.5' python -c \
  'import json; from harbor.models.trajectories import Trajectory; print(json.dumps(Trajectory.model_json_schema(mode="validation"), indent=2, sort_keys=True))'
```

The checked-in artifact adds only the pinned `$id` and `x-harbor-source`
provenance object to that generated output. The JSON Schema covers field shape.
Harbor's model-level rules are mirrored in
`src/atif.ts`: sequential one-based step IDs, source-specific fields, ISO
timestamps, same-step tool-result references, resolvable subagent references,
and present/unique IDs on embedded subagent trajectories.

The generated schema and upstream source are Apache-2.0; the corresponding
license is preserved in `harbor-atif-v1.7.LICENSE`.
