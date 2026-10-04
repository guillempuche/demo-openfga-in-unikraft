# Modular OpenFGA model for a project-management app:
#   org → team → folder → project → list → task
#
# Each module owns one area; types can reference each other across modules,
# and tasks.fga extends `project` without editing projects.fga.
# Tests: one *.fga.yaml file per feature next to this manifest
#   fga model test --tests 'authz/models/*.fga.yaml'
#
# Docs: https://openfga.dev/docs/modeling/modular-models

schema: '1.2'

contents:
  - core.fga
  - conditions.fga
  - projects.fga
  - tasks.fga
