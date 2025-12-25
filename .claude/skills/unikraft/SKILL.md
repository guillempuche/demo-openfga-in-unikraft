---
name: unikraft
description: Kraft CLI commands for building and deploying Unikraft unikernels. Use when working with Kraftfiles, deploying to Unikraft Cloud, or managing unikernel instances.
---

# Kraft CLI Reference

Build and deploy unikernels with the `kraft` CLI.

- Documentation: https://unikraft.org/docs/cli
- Issues & support: https://github.com/unikraft/kraftkit/issues
- Platform: https://unikraft.cloud

## Environment Setup

Required for cloud commands:

```bash
export UKC_TOKEN="your-token"   # Unikraft Cloud API token
export UKC_METRO=fra            # Metro/region (e.g., fra, ams, lon)
```

## Build Commands

```bash
kraft build                 # Configure and build Unikraft unikernels
kraft clean                 # Remove build object files
kraft menu                  # Open configuration editor TUI
```

## Project Library Commands

```bash
kraft lib add <lib>         # Add unikraft library to the project
kraft lib create            # Initialize a library from a template
kraft lib remove <lib>      # Remove a library dependency
```

## Packaging Commands

```bash
kraft pkg list              # List installed Unikraft component packages
kraft pkg pull <pkg>        # Pull a unikernel and/or its dependencies
kraft pkg push              # Push a unikernel package to registry
kraft pkg update            # Retrieve new component/library/package lists
kraft pkg info <pkg>        # Show information about a package
kraft pkg export            # Export a package
kraft pkg remove            # Remove selected local packages
```

## Local Runtime Commands

```bash
kraft run                   # Run a unikernel
kraft ps                    # List running unikernels
kraft stop <name>           # Stop one or more running unikernels
kraft start <name>          # Start one or more machines
kraft pause <name>          # Pause one or more running unikernels
kraft logs <name>           # Fetch the logs of a unikernel
kraft remove <name>         # Remove one or more running unikernels
```

## Local Networking Commands

```bash
kraft net create            # Create a new machine network
kraft net list              # List machine networks
kraft net inspect <name>    # Inspect a machine network
kraft net up <name>         # Bring a network online
kraft net down <name>       # Bring a network offline
kraft net remove <name>     # Remove a network
```

## Local Volume Commands

```bash
kraft vol create            # Create a machine volume
kraft vol ls                # List machine volumes
kraft vol inspect <name>    # Inspect a machine volume
kraft vol remove <name>     # Remove a volume
```

## Compose Commands (Local)

```bash
kraft compose up            # Run a compose project
kraft compose down          # Stop and remove a compose project
kraft compose ps            # List running services of current project
kraft compose logs          # Print the logs of services
kraft compose build         # Build or rebuild services
kraft compose create        # Create a compose project
kraft compose start         # Start a compose project
kraft compose stop          # Stop a compose project
kraft compose pause         # Pause a compose project
kraft compose unpause       # Unpause a compose project
kraft compose pull          # Pull images of services
kraft compose push          # Push images of services
```

## Cloud Deployment Commands

```bash
kraft cloud deploy          # Deploy your application to Unikraft Cloud
kraft cloud quota           # View your resource quota
kraft cloud tunnel          # Forward a local port to an unexposed instance
```

## Cloud Instance Commands

```bash
kraft cloud instance create   # Create an instance
kraft cloud instance list     # List instances
kraft cloud instance get      # Retrieve the state of instances
kraft cloud instance logs     # Get console output of instances
kraft cloud instance start    # Start instances
kraft cloud instance stop     # Stop instances
kraft cloud instance restart  # Restart instance(s)
kraft cloud instance remove   # Remove instances
```

## Cloud Service Commands

```bash
kraft cloud service create  # Create a service
kraft cloud service list    # List services
kraft cloud service get     # Retrieve the state of services
kraft cloud service logs    # Get console output for services
kraft cloud service drain   # Drain instances in a service
kraft cloud service remove  # Delete services
```

## Cloud Image Commands

```bash
kraft cloud image list      # List all images at a metro for your account
kraft cloud image remove    # Remove an image
```

## Cloud Volume Commands

```bash
kraft cloud volume create   # Create a persistent volume
kraft cloud volume list     # List persistent volumes
kraft cloud volume get      # Retrieve the state of persistent volumes
kraft cloud volume import   # Import local data to a persistent volume
kraft cloud volume attach   # Attach a persistent volume to an instance
kraft cloud volume detach   # Detach a persistent volume from an instance
kraft cloud volume remove   # Permanently delete persistent volume(s)
```

## Cloud Volume Template Commands

```bash
kraft cloud volume template create  # Create volume template(s)
kraft cloud volume template list    # List volume templates
kraft cloud volume template get     # Retrieve the state of volume templates
kraft cloud volume template remove  # Permanently delete volume template(s)
```

## Cloud Autoscale Commands

```bash
kraft cloud scale init      # Initialize autoscale configuration for a service
kraft cloud scale add       # Add an autoscale configuration policy
kraft cloud scale get       # Get an autoscale configuration or policy
kraft cloud scale remove    # Delete an autoscale configuration policy
kraft cloud scale reset     # Reset autoscale configuration of a service
```

## Cloud Certificate Commands

```bash
kraft cloud cert create     # Create a certificate
kraft cloud cert list       # List certificates
kraft cloud cert get        # Retrieve the status of a certificate
kraft cloud cert remove     # Remove a certificate
```

## Cloud Compose Commands

```bash
kraft cloud compose up      # Deploy services in a compose project to Unikraft Cloud
kraft cloud compose down    # Stop and remove services in a deployment
kraft cloud compose ps      # List active services of a Compose project
kraft cloud compose log     # View logs of services in a deployment
kraft cloud compose build   # Build a compose project
kraft cloud compose create  # Create a deployment from a Compose project
kraft cloud compose start   # Start services in a deployment
kraft cloud compose stop    # Stop services in a deployment
kraft cloud compose push    # Push images to Unikraft Cloud from a Compose project
kraft cloud compose ls      # List service deployments at a given path
```

## Useful Flags

```bash
--no-prompt                 # Do not prompt for user interaction
--no-color                  # Disable color output
--log-level <level>         # Log level: panic, fatal, error, warn, info, debug, trace
--help                      # Help for any command
```
