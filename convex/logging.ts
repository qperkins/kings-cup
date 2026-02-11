export type GameStateContext = {
    session_id: string | null
    round_number: number | null
    total_players: number | null
    turn_index: number | null
    card_rank: string | null
    card_suit: string | null
    rule_triggered: string | null
    kings_drawn: number | null
    center_cup_volume_ml: number | null
    players_remaining: number | null
    player_id: string | null
    is_host: boolean | null
    drinks_taken_total: number | null
}

export const buildGameStateContext = (
    overrides: Partial<GameStateContext> = {}
): GameStateContext => ({
    session_id: null,
    round_number: null,
    total_players: null,
    turn_index: null,
    card_rank: null,
    card_suit: null,
    rule_triggered: null,
    kings_drawn: null,
    center_cup_volume_ml: null,
    players_remaining: null,
    player_id: null,
    is_host: null,
    drinks_taken_total: null,
    ...overrides,
})
