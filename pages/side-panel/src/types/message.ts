export const ACTOR_PROFILES = {
  user: {
    name: 'User',
    icon: 'icons/user.svg',
    iconBackground: '#4CAF50',
  },
  system: {
    // The product's own voice. Task outcomes, notices and errors all arrive under this actor, and
    // to the user they come from Flowkite - "System" read like machinery talking about itself.
    name: 'Flowkite',
    icon: 'icons/system.svg',
    iconBackground: '#2196F3',
  },
  planner: {
    name: 'Planner',
    icon: 'icons/planner.svg',
    iconBackground: '#FF9800',
  },
  navigator: {
    name: 'Navigator',
    icon: 'icons/navigator.svg',
    iconBackground: '#40A9FF',
  },
  validator: {
    name: 'Validator',
    icon: 'icons/validator.svg',
    iconBackground: '#EC407A',
  },
  manager: {
    name: 'Manager',
    icon: 'icons/manager.svg',
    iconBackground: '#9C27B0',
  },
  evaluator: {
    name: 'Evaluator',
    icon: 'icons/evaluator.svg',
    iconBackground: '#795548',
  },
} as const;
