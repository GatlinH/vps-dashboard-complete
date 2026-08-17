import {
  createServerGroup,
  deleteServerGroup,
  deleteServerGroupsBulk,
  fetchServerGroups,
  updateServerGroup,
} from '../api/serverGroups.js';

export const groupFormApi = {
  create: createServerGroup,
  update: updateServerGroup,
  remove: deleteServerGroup,
  removeBulk: deleteServerGroupsBulk,
  list: fetchServerGroups,
};
