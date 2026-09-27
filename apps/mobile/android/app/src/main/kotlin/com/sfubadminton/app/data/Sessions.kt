package com.sfubadminton.app.data

import com.sfubadminton.app.shared.activeSeasonOrFilter
import com.sfubadminton.app.shared.clubToday
import com.sfubadminton.app.shared.visibleTracksFor
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.util.Locale

// Port of the Expo app's src/lib/sessions.ts and the date helpers from its
// SessionsScreen.tsx. Keep in step with them.

@Serializable
data class ActiveSeasonRow(val id: String, val name: String? = null)

/** get_active_season() returns a set; the first row is the season, none means no season. */
suspend fun loadActiveSeason(postgrest: Postgrest): ActiveSeasonRow? =
    postgrest.list(PostgrestQuery.rpc("get_active_season"), ActiveSeasonRow.serializer(), "the season").firstOrNull()

@Serializable
data class UpcomingSession(
    val id: String,
    val name: String? = null,
    val date: String,
    @SerialName("start_time") val startTime: String? = null,
    @SerialName("end_time") val endTime: String? = null,
    val location: String = "",
    val track: String = "",
)

fun upcomingSessionsQuery(playerStatus: String?, today: String, activeSeasonId: String?): PostgrestQuery {
    var query = PostgrestQuery.select("sessions", "id, name, date, start_time, end_time, location, track")
        .eq("status", "open")
        .isIn("track", visibleTracksFor(playerStatus))
        .gte("date", today)
    val seasonFilter = activeSeasonOrFilter(activeSeasonId)
    if (seasonFilter != null) query = query.or(seasonFilter)
    return query
        .order("date", ascending = true)
        .order("start_time", ascending = true, nullsLast = true)
}

/**
 * Open sessions from today on, in the active season (and season-less ones), on
 * the member's tracks: the scope of the web's schedule, with "today" taken on
 * the club's clock rather than the phone's.
 */
suspend fun loadUpcomingSessions(postgrest: Postgrest, playerStatus: String?): List<UpcomingSession> {
    val season = loadActiveSeason(postgrest)
    return postgrest.list(
        upcomingSessionsQuery(playerStatus, clubToday(), season?.id),
        UpcomingSession.serializer(),
        "sessions",
    )
}

private val SESSION_DATE: DateTimeFormatter = DateTimeFormatter.ofPattern("EEE d MMM", Locale.US)

/** "Sun 4 Oct" from a Postgres DATE, read as a date with no zone so it cannot slip a day. */
fun formatSessionDate(date: String): String = try {
    LocalDate.parse(date.take(10)).format(SESSION_DATE)
} catch (e: DateTimeParseException) {
    date
}

fun timeRange(start: String?, end: String?): String {
    val s = start?.take(5)
    val e = end?.take(5)
    if (!s.isNullOrEmpty() && !e.isNullOrEmpty()) return "$s to $e"
    return s ?: ""
}
