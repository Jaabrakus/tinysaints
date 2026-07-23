# Torch

A standalone HTML5 Canvas proof-of-concept for make/room's first collaborative game.

## Prototype goal

Two local players must carry one flame from the first bonfire to the next. The torch loses strength when its carrier sprints, enters wind, or separates from the companion. Either player can collect shared tinder, refuel the torch, and take responsibility for carrying it.

## Run locally

Serve this directory with any static web server and open `index.html`. The prototype has no packages, external assets, accounts, persistence, or network calls.

## Convergence boundary

Keep this prototype independent until the movement, passing, flame drain, refueling, failure, and victory loops feel right. After that, copy the three runtime files into a make/room game project and use them as the first AI-editable playable build.
